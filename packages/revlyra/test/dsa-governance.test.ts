import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sha256Hex } from '@revlyra/core';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultHandlers } from '../src/jobs';
import { SqliteStore } from '../src/store/sqlite';

function hmac(value: string): string {
  return sha256Hex(`t:reviewer:${value}`);
}

describe('store governance migration (pre-002 databases)', () => {
  it('adds the DSA appeal columns to a legacy appeals table', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'revlyra-migration-'));
    const path = join(dir, 'legacy.db');
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE appeals (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      review_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      reason TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      resolver_hmac TEXT
    )`);
    legacy.close();

    const store = new SqliteStore(path);
    await store.migrate();
    const appeal = await store.createAppeal({
      tenantId: 'default',
      reviewId: 'r1',
      slaDueAt: '2026-11-24T00:00:00Z',
    });
    expect(appeal.slaDueAt).toBe('2026-11-24T00:00:00Z');
    const resolved = await store.resolveAppeal(
      'default',
      appeal.id,
      'overturned',
      'handler-hmac',
      'note',
    );
    expect(resolved?.handlerHmac).toBe('handler-hmac');
    expect(resolved?.outcomeNote).toBe('note');
    expect(resolved?.status).toBe('overturned');
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('notices + heterogeneous campaign edges', () => {
  let store: SqliteStore;

  async function ready(): Promise<SqliteStore> {
    if (store) return store;
    store = new SqliteStore(':memory:');
    await store.migrate();
    await store.ensureTenant('default');
    return store;
  }

  afterAll(async () => {
    await store?.close();
  });

  it('stores notices with status transitions', async () => {
    const store = await ready();
    const notice = await store.insertNotice({
      tenantId: 'default',
      reviewId: 'r-9',
      type: 'complaint',
      claim: 'The review misstates the incident; see the police report.',
      substantiated: true,
    });
    const fetched = await store.getNotice('default', notice.id);
    expect(fetched?.status).toBe('received');
    expect(fetched?.substantiated).toBe(true);

    const underReview = await store.updateNoticeStatus('default', notice.id, {
      status: 'under_review',
    });
    expect(underReview?.status).toBe('under_review');
    expect(underReview?.resolvedAt).toBeNull();
    const actioned = await store.updateNoticeStatus('default', notice.id, {
      status: 'actioned',
      note: 'label corrected',
    });
    expect(actioned?.resolvedAt).toBeTruthy();
    expect(actioned?.metadata.statusNote).toBe('label corrected');
    expect((await store.listNotices('default', { status: 'actioned' })).length).toBe(1);
    expect((await store.listNotices('default', { reviewId: 'r-9' })).length).toBe(1);
  });

  it('finds a heterogeneous campaign from shared template hashes on disjoint items', async () => {
    const store = await ready();
    const submitted = [
      '2026-10-20T09:00:00Z',
      '2026-10-20T10:00:00Z',
      '2026-10-20T11:00:00Z',
      '2026-10-20T12:00:00Z',
    ];
    const shared =
      'Absolutely stunning results highly recommend to everyone interested in this category';
    for (let index = 0; index < 4; index += 1) {
      const reviewerId = `graph-rev-${index}`;
      await store.upsertReviewer({ tenantId: 'default', externalHmac: hmac(reviewerId) });
      await store.upsertItem({ tenantId: 'default', externalHmac: hmac(`item-${index}`) });
      await store.upsertReview({
        tenantId: 'default',
        externalHmac: `xm-${index}`,
        itemId: hmac(`item-${index}`),
        reviewerId: hmac(reviewerId),
        rating: 5,
        text: shared,
        textSha256: shared.replace(/\s+/gu, ' ').trim().toLowerCase(),
        simhash: sha256Hex(`sim-${index}`),
        language: 'en',
        submittedAt: submitted[index]!,
        verified: false,
        context: { subnet: '203.0.113.0/24' },
        media: [],
      });
      await store.upsertReviewEdge({
        tenantId: 'default',
        reviewId: `xm-${index}`,
        itemId: hmac(`item-${index}`),
        reviewerId: hmac(reviewerId),
        submittedAt: submitted[index]!,
        risk: 0.2,
        signals: ['content'],
      });
    }

    const keys = await store.listReviewGroupKeys('default', '2026-10-01T00:00:00Z');
    expect(keys).toHaveLength(4);
    expect(new Set(keys.map((row) => row.textSha256)).size).toBe(1);

    const result = await defaultHandlers.campaigns(
      {
        kind: 'campaigns',
        tenantId: 'default',
        payload: {},
        id: 'job-1',
        status: 'running',
        result: null,
        error: null,
        attempts: 0,
        maxAttempts: 1,
        runAfter: '2026-10-25T00:00:00Z',
        claimedAt: null,
        createdAt: '2026-10-25T00:00:00Z',
        updatedAt: '2026-10-25T00:00:00Z',
      },
      { store, service: undefined as never, config: {} as never },
    );
    // 4 template edges + 4 subnet edges (every review shares the subnet group).
    expect(result.groupEdges).toBeGreaterThanOrEqual(8);

    const campaigns = await store.listCampaigns('default', 10);
    const heterogeneous = campaigns.find(
      (campaign) =>
        Array.isArray(campaign.evidence.edgeKinds) &&
        (campaign.evidence.edgeKinds as string[]).includes('same_template'),
    );
    expect(heterogeneous).toBeTruthy();
  });
});
