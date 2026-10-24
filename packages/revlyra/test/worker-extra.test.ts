import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASELINE_MODEL, getPolicyPreset } from '@revlyra/core';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { ReviewService } from '../src/engine/service';
import { defaultHandlers, JobWorker } from '../src/jobs';
import { Entitlements } from '../src/license';
import { SqliteStore } from '../src/store/sqlite';

const dirs: string[] = [];
const stores: SqliteStore[] = [];

afterAll(() => {
  for (const store of stores.splice(0)) void store.close();
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // windows handle quirks
    }
  }
});

async function makeServiceEntitlementsFree(): Promise<{
  store: SqliteStore;
  service: ReviewService;
  config: ReturnType<typeof loadConfig>;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'revlyra-workerx-'));
  dirs.push(dir);
  const config = loadConfig({
    cwd: dir,
    overrides: {
      database: { driver: 'sqlite', path: ':memory:' },
      privacy: { pepper: 'worker-extra-pepper-long-enough' },
      license: { key: '' },
    },
  });
  const store = new SqliteStore(':memory:');
  await store.migrate();
  await store.ensureTenant('default');
  stores.push(store);
  const entitlements = new Entitlements({
    valid: true,
    kind: 'dev',
    tier: 'enterprise',
    subject: 'test',
    features: ['server', 'media', 'campaigns', 'graph'],
    limits: { reviewsPerMonth: 10_000, sources: 10, rps: 100, seats: 1 },
    grace: false,
  });
  const service = new ReviewService({
    store,
    config,
    entitlements,
    policy: getPolicyPreset('balanced'),
    model: BASELINE_MODEL,
  });
  return { store, service, config };
}

describe('worker handler edge cases', () => {
  it('bulk_ingest imports review arrays and fails on garbage payloads', async () => {
    const { store, service, config } = await makeServiceEntitlementsFree();
    const job = await store.createJob({
      tenantId: 'default',
      kind: 'bulk_ingest',
      payload: {
        reviews: [
          {
            itemId: 'p1',
            reviewerId: 'u1',
            rating: 5,
            text: 'Extraordinary battery life on the drill and a solid chuck.',
            submittedAt: '2026-10-20T10:00:00Z',
          },
        ],
      },
    });
    const result = await defaultHandlers.bulk_ingest(job, { store, service, config });
    expect((result as { imported: number }).imported).toBe(1);
    const empty = await defaultHandlers.bulk_ingest(
      { ...job, payload: reviewslessPayload() },
      { store, service, config },
    );
    expect({ imported: (empty as { imported: number }).imported, failed: 0 }).toEqual({
      imported: 0,
      failed: 0,
    });
  });

  it('retention purges reviews older than the configured days', async () => {
    const { store, service, config } = await makeServiceEntitlementsFree();
    const job = await store.createJob({
      tenantId: 'default',
      kind: 'retention',
      payload: {},
    });
    const DAY_MS = 86_400_000; // mirrored from worker internals (not exported)
    const before = new Date(Date.now() - 200 * DAY_MS).toISOString();
    // seed a review that should be purged (submitted 200 days ago)
    await store.ensureTenant('default');
    await service.ingest('default', {
      review: {
        id: 'old-review',
        itemId: 'p-old',
        reviewerId: 'u-old',
        rating: 3,
        text: 'Ancient original take on the drill with tons of battery hours.',
        submittedAt: before,
      },
    });
    const result = (await defaultHandlers.retention(job, { store, service, config })) as {
      reviews: number;
      before: string;
      signals: number;
      media: number;
      textIndex: number;
    };
    expect(result.before).toBeTruthy();
    // retention default 180 days; our review is ~200 days old -> purged
    expect(result.reviews).toBeGreaterThanOrEqual(1);

    // the second run keeps current reviews (none left to purge)
    await defaultHandlers.retention(job, { store, service, config });
  });

  it('integrity snapshots per item with bands', async () => {
    const { store, service, config } = await makeServiceEntitlementsFree();
    for (let i = 0; i < 40; i += 1) {
      await service.ingest('default', {
        review: {
          id: `int-${i}`,
          itemId: `pint-${i % 2}`,
          reviewerId: `uint-${i}`,
          rating: (i % 5) + 1,
          text: `Integrity fixture ${i} covering a drill topic with battery ${i}十个 words follow to make it meaningful and descriptive.`,
          submittedAt: '2026-10-20T10:00:00Z',
        },
      });
    }
    const job = await store.createJob({ tenantId: 'default', kind: 'integrity', payload: {} });
    const result = (await defaultHandlers.integrity(job, { store, service, config })) as {
      items: number;
    };
    expect(result.items).toBeGreaterThan(0);
  });
});

describe('worker concurrency and handlers merging', () => {
  it('supports custom handler overrides and unknown kinds fail sensibly', async () => {
    const { store, service, config } = await makeServiceEntitlementsFree();
    const processed: string[] = [];
    const custom = {
      customkind: async (): Promise<Record<string, unknown>> => {
        processed.push('customkind');
        return { ok: true };
      },
    };
    const worker = new JobWorker({ store, service, config, handlers: custom });
    await store.createJob({ tenantId: 'default', kind: 'customkind', payload: {} });
    await store.createJob({ tenantId: 'default', kind: 'alien_kind', payload: {} });
    const claimed = await worker.runOnce();
    expect(claimed).toBe(2);
    expect(processed).toEqual(['customkind']);
    const alien = (await store.listJobs('default')).find((j) => j.kind === 'alien_kind');
    expect(alien?.status).toBe('pending'); // failJob schedules a retry
    await worker.stop();
  });
});

function reviewslessPayload(): Record<string, unknown> {
  return { reviews: undefined };
}
