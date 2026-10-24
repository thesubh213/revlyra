import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASELINE_MODEL, getPolicyPreset } from '@revlyra/core';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig, type RevlyraConfig } from '../src/config';
import { ReviewService } from '../src/engine/service';
import { Entitlements, type LicenseStatus } from '../src/license';
import { SqliteStore } from '../src/store/sqlite';

const dirs: string[] = [];
const services: ReviewService[] = [];
const stores: SqliteStore[] = [];

afterAll(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // windows quirks
    }
  }
});

function status(overrides: Partial<LicenseStatus> = {}): LicenseStatus {
  return {
    valid: true,
    kind: 'dev',
    tier: 'enterprise',
    subject: 'test',
    features: ['server', 'media', 'campaigns', 'graph'],
    limits: { reviewsPerMonth: 10_000, sources: 10, rps: 100, seats: 1 },
    grace: false,
    ...overrides,
  };
}

async function makeService(entitlements: Entitlements): Promise<{
  store: SqliteStore;
  service: ReviewService;
  config: RevlyraConfig;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'revlyra-service-'));
  dirs.push(dir);
  const config = loadConfig({
    cwd: dir,
    overrides: {
      database: { driver: 'sqlite', path: ':memory:' },
      privacy: { pepper: 'service-pepper-long-enough' },
      license: { key: '' },
    },
  });
  const store = new SqliteStore(':memory:');
  await store.migrate();
  await store.ensureTenant('default');
  const service = new ReviewService({
    store,
    config,
    entitlements,
    policy: getPolicyPreset('balanced'),
    model: BASELINE_MODEL,
  });
  services.push(service);
  stores.push(store);
  return { store, service, config };
}

afterAll(() => {
  for (const store of stores.splice(0)) {
    void store.close();
  }
});

function reviewInput(overrides: Record<string, unknown> = {}) {
  return {
    review: {
      id: 'svc-r1',
      itemId: 'svc-1',
      reviewerId: 'svc-u1',
      rating: 4,
      text: 'Solid service test drill with a battery lasting three hours overall.',
      submittedAt: '2026-10-20T10:00:00Z',
      ...overrides,
    },
    // reviewer hints with an identity-shaped stat get scrubbed before persist
    reviewer: {
      accountCreatedAt: '2024-01-01T00:00:00Z',
      stats: { linkedin: 'https://linkedin.com/in/john-doe', extra: 1 },
    },
  };
}

describe('ReviewService edge lifecycle', () => {
  it('ingests with identity scrubbing and audits the stripped metadata', async () => {
    const { store, service } = await makeService(new Entitlements(status()));
    await service.ingest('default', reviewInput());
    const audit = await store.listAudit('default', 50);
    expect(audit.some((entry) => entry.action === 'review.identity_keys_stripped')).toBe(true);
  });

  it('serves idempotent replays from the stored analysis instead of re-scoring', async () => {
    const { store, service } = await makeService(new Entitlements(status()));
    const first = await service.ingest('default', reviewInput());
    const before = await store.getCorpusStats('default');
    const second = await service.ingest('default', reviewInput());
    expect(second.result.reviewId).toBe(first.result.reviewId);
    expect(Math.abs(second.result.score - first.result.score)).toBeLessThan(1e-9);
    const after = await store.getCorpusStats('default');
    expect(after.totalReviews).toBe(before.totalReviews);
  });

  it('throws LicenseError when entitlements are invalid', async () => {
    const { service } = await makeService(new Entitlements(status({ valid: false })));
    let error: unknown = null;
    try {
      await service.ingest('default', reviewInput());
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toMatch(/License/i);
    expect(() => service.assertLicense()).toThrow(/License/i);
  });

  it('enforces the monthly review limit with LimitError', async () => {
    const { store, service } = await makeService(
      new Entitlements(
        status({
          tier: 'pro',
          limits: { reviewsPerMonth: 1, sources: 1, rps: 10, seats: 1 },
        }),
      ),
    );
    await service.ingest('default', {
      review: {
        itemId: 'lim-1',
        reviewerId: 'lim-u1',
        rating: 5,
        text: 'First solid review that fills the monthly test budget with a drill.',
        submittedAt: '2026-10-20T10:00:00Z',
      },
    });
    await expect(
      service.ingest('default', {
        review: {
          itemId: 'lim-1',
          reviewerId: 'lim-u2',
          rating: 5,
          text: 'Second review crosses the monthly test quota in this synthetic case.',
          submittedAt: '2026-10-21T10:00:00Z',
        },
      }),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    void store;
  });

  it('rebuilds a result from stored signals via rebuildResult', async () => {
    const { store, service } = await makeService(new Entitlements(status()));
    const ingested = await service.ingest('default', reviewInput());
    const signals = await store.getSignals(ingested.review.id);
    const rebuilt = service.rebuildResult(ingested.review, signals);
    expect(rebuilt.reviewId).toBe(ingested.review.id);
    expect(rebuilt.score).toBeCloseTo(ingested.result.score, 3);
  });

  it('computes an integrity block for an item via computeIntegrity', async () => {
    const { service } = await makeService(new Entitlements(status()));
    await service.ingest('default', reviewInput());
    const integrity = await service.computeIntegrity('default', 'svc-1');
    expect(integrity?.integrity.rawRating).toBeCloseTo(4, 3);
  });

  it('helpfully forget unknown reviews in getResult', async () => {
    const { service } = await makeService(new Entitlements(status()));
    expect(await service.getResult('default', 'no-such-review')).toBeNull();
  });
});
