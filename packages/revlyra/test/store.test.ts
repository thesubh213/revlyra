import {
  minhashBandKeys,
  minhashSignature,
  normalizeReview,
  shingles,
  simhashBandKeys,
} from '@revlyra/core';
import { afterEach, describe, expect, it } from 'vitest';
import { generateApiKey } from '../src/keys';
import { SqliteStore } from '../src/store/sqlite';

let store: SqliteStore | null = null;

afterEach(async () => {
  await store?.close();
  store = null;
});

async function makeStore(): Promise<SqliteStore> {
  store = new SqliteStore(':memory:');
  await store.migrate();
  return store;
}

function reviewInput(tenantId: string, index = 1) {
  const review = {
    id: `review-${index}`,
    itemId: 'item-1',
    reviewerId: 'reviewer-1',
    rating: 5,
    text: 'This is a detailed review about a drill that lasted about four hours on a charge and came with a solid case.',
    submittedAt: `2026-10-2${index}T10:00:00Z`,
  };
  const normalized = normalizeReview(review);
  return {
    tenantId,
    externalHmac: `rh-${index}`,
    itemId: 'item-1',
    reviewerId: 'reviewer-1',
    rating: review.rating,
    text: normalized.text,
    textSha256: normalized.exactHash,
    simhash: normalized.simhash,
    language: normalized.language,
    submittedAt: review.submittedAt,
    verified: true,
    context: {},
    media: [],
  };
}

describe('sqlite store', () => {
  it('manages tenants and API keys', async () => {
    const db = await makeStore();
    const tenant = await db.ensureTenant('acme', 'Acme');
    expect(tenant.id).toBe('acme');

    const material = generateApiKey('live');
    const key = await db.createApiKey({
      tenantId: 'acme',
      prefix: material.prefix,
      keyHash: material.hash,
      scopes: ['analyze:write'],
    });
    expect((await db.findApiKeyByHash(material.hash))?.id).toBe(key.id);
    expect((await db.findApiKeyByPrefix(material.prefix))?.id).toBe(key.id);
    expect(await db.revokeApiKey('acme', key.id)).toBe(true);
    expect((await db.findApiKeyByHash(material.hash))?.revokedAt).not.toBeNull();
  });

  it('stores reviews, signals, reviewer and item aggregates', async () => {
    const db = await makeStore();
    await db.ensureTenant('acme');
    const reviewer = await db.upsertReviewer({
      tenantId: 'acme',
      externalHmac: 'reviewer-hmac',
      accountCreatedAt: '2024-01-01T00:00:00Z',
      stats: { sharedDeviceCount: 2 },
    });
    const item = await db.upsertItem({
      tenantId: 'acme',
      externalHmac: 'item-hmac',
      category: 'tools',
    });

    const record = await db.upsertReview({
      ...reviewInput('acme'),
      reviewerId: reviewer.id,
      itemId: item.id,
    });
    expect(record.id).toBeTruthy();

    await db.updateReviewAnalysis('acme', record.id, {
      score: 0.82,
      confidence: 0.7,
      decision: 'hold',
      band: 'high',
      provisional: false,
      modelVersion: 'm1',
      policyVersion: 'p1',
      analysisHash: 'hash',
    });
    await db.insertSignals(record.id, [
      {
        id: 1,
        reviewId: record.id,
        code: 'TEXT_EXACT_DUPLICATE_CROSS_ACCOUNT',
        family: 'content',
        severity: 0.9,
        confidence: 0.9,
        contribution: 2,
        evidence: { match: 'x' },
        explanation: 'duplicate',
        hard: true,
      },
    ]);

    const updated = await db.getReview('acme', record.id);
    expect(updated?.decision).toBe('hold');
    expect(updated?.score).toBeCloseTo(0.82);
    expect((await db.getSignals(record.id))[0]?.hard).toBe(true);

    const aggregates = await db.getReviewerAggregates('acme', reviewer.id);
    expect(aggregates.totalReviews).toBe(1);
    expect(aggregates.ratingDistribution[4]).toBe(1);
    expect(aggregates.recentTimestamps).toHaveLength(1);

    const itemAggregates = await db.getItemAggregates('acme', item.id);
    expect(itemAggregates.averageRating).toBe(5);
    expect((await db.getCorpusStats('acme')).totalReviews).toBe(1);
  });

  it('finds exact text reuse and media reuse', async () => {
    const db = await makeStore();
    await db.ensureTenant('acme');
    const first = await db.upsertReview(reviewInput('acme', 1));
    const second = await db.upsertReview(reviewInput('acme', 2));
    const normalized = normalizeReview({
      id: 'review-2',
      itemId: 'item-1',
      reviewerId: 'reviewer-1',
      rating: 5,
      text: second.text,
      submittedAt: second.submittedAt,
    });

    await db.upsertTextIndex({
      tenantId: 'acme',
      reviewId: first.id,
      reviewerId: first.reviewerId,
      itemId: first.itemId,
      textSha256: normalized.exactHash,
      simhash: normalized.simhash,
      simhashBands: simhashBandKeys(normalized.simhash, 4, 16),
      minhashBands: minhashBandKeys(minhashSignature(shingles(normalized.tokens, 5)), 16),
      submittedAt: first.submittedAt,
    });

    const matches = await db.findTextMatches('acme', {
      textSha256: normalized.exactHash,
      simhash: normalized.simhash,
      simhashBands: simhashBandKeys(normalized.simhash, 4, 16),
      minhashBands: minhashBandKeys(minhashSignature(shingles(normalized.tokens, 5)), 16),
      excludeReviewId: second.id,
    });
    expect(matches.some((match) => match.reviewId === first.id && match.kind === 'exact')).toBe(
      true,
    );

    await db.upsertMedia({
      tenantId: 'acme',
      reviewId: first.id,
      reviewerId: first.reviewerId,
      itemId: first.itemId,
      sha256: `${'abc'.repeat(21)}a`,
      phash: '0123456789abcdef',
      phashBands: simhashBandKeys('0123456789abcdef', 4, 16),
    });
    const mediaMatches = await db.findMediaMatches('acme', {
      sha256: `${'abc'.repeat(21)}a`,
      phash: '0123456789abcdef',
      phashBands: simhashBandKeys('0123456789abcdef', 4, 16),
      excludeReviewId: second.id,
    });
    expect(mediaMatches[0]?.kind).toBe('exact');
  });

  it('runs jobs, audit chain, usage and campaigns', async () => {
    const db = await makeStore();
    await db.ensureTenant('acme');

    const job = await db.createJob({ tenantId: 'acme', kind: 'scan', payload: {} });
    const claimed = await db.claimJob();
    expect(claimed?.id).toBe(job.id);
    await db.completeJob(job.id, { imported: 2 });
    expect((await db.getJob('acme', job.id))?.status).toBe('completed');

    await db.appendAudit({
      tenantId: 'acme',
      actor: 'test',
      action: 'a',
      targetType: 'review',
      targetId: 'r1',
      payload: { n: 1 },
    });
    await db.appendAudit({
      tenantId: 'acme',
      actor: 'test',
      action: 'b',
      targetType: 'review',
      targetId: 'r2',
      payload: { n: 2 },
    });
    expect((await db.verifyAudit('acme')).valid).toBe(true);

    expect(await db.incrementUsage('acme', 'reviews', '2026-10', 3)).toBe(3);
    expect(await db.getUsage('acme', 'reviews', '2026-10')).toBe(3);

    await db.upsertCampaign({
      id: 'cmp_1',
      tenantId: 'acme',
      kind: 'coordinated',
      score: 0.8,
      density: 0.5,
      memberCount: 3,
      reviewerIds: ['a', 'b', 'c'],
      itemIds: ['p1'],
      evidence: { signalFamilies: ['text', 'temporal'] },
      status: 'candidate',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect((await db.getCampaignForReviewer('acme', 'b'))?.id).toBe('cmp_1');
  });

  it('purges expired reviews and indexes', async () => {
    const db = await makeStore();
    await db.ensureTenant('acme');
    const record = await db.upsertReview({
      ...reviewInput('acme', 1),
      submittedAt: '2020-01-01T00:00:00Z',
    });
    const purged = await db.purgeOlderThan('acme', '2021-01-01T00:00:00Z');
    expect(purged.reviews).toBe(1);
    expect(await db.getReview('acme', record.id)).toBeNull();
  });
});
