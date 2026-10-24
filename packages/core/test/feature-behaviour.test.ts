import { describe, expect, it } from 'vitest';
import { extractBehaviourFeatures } from '../src';
import type { AnalysisContext, CanonicalReview, ReviewerProfile } from '../src/types';

const NOW = '2026-10-24T10:00:00.000Z';

function review(overrides: Partial<CanonicalReview> = {}): CanonicalReview {
  return {
    id: 'r',
    itemId: 'item',
    reviewerId: 'user',
    rating: 4,
    text: 'fine product',
    submittedAt: NOW,
    ...overrides,
  };
}

function reviewer(overrides: Partial<ReviewerProfile> = {}): ReviewerProfile {
  return { id: 'user', ...overrides };
}

function features(
  profile?: ReviewerProfile,
  analysis: Partial<AnalysisContext> = {},
  r = review(),
) {
  return extractBehaviourFeatures(r, { reviewer: profile, now: NOW, ...analysis });
}

describe('extractBehaviourFeatures', () => {
  it('marks missing reviewer history', () => {
    const f = features(undefined);
    expect(f['beh.historyAvailable']).toBe(0);
    expect(f['beh.accountAgeKnown']).toBe(0);
    expect(f['beh.accountAgeDays']).toBe(365);
    expect(f['beh.velocity']).toBeGreaterThanOrEqual(0);
    expect(f['beh.daysSinceLastReview']).toBe(1);
  });

  it('computes account age and clamps future account dates at 0', () => {
    const f = features(reviewer({ accountCreatedAt: '2026-10-20T00:00:00.000Z' }));
    expect(f['beh.accountAgeDays']).toBeCloseTo(4 + 10 / 24, 9);
    expect(f['beh.accountAgeKnown']).toBe(1);
    expect(f['beh.newAccount']).toBe(1); // under 7 days

    const future = features(reviewer({ accountCreatedAt: '2026-12-01T00:00:00.000Z' }));
    expect(future['beh.accountAgeDays']).toBe(0);
    expect(future['beh.newAccount']).toBe(1);

    const old = features(reviewer({ accountCreatedAt: '2020-01-01T00:00:00.000Z' }));
    expect(old['beh.accountAgeDays']).toBeGreaterThan(365);
    expect(old['beh.newAccount']).toBe(0);
  });

  it('flags velocity from 24h/7d/30d windows and peer level', () => {
    // 5 reviews in 24h saturates the first component.
    expect(features(reviewer({ reviewsLast24h: 5 }))['beh.velocity']).toBeCloseTo(1, 8);
    // 100 reviews in 30 days saturates the third component.
    expect(features(reviewer({ reviewsLast30d: 60 }))['beh.velocity']).toBeCloseTo(1, 8);
    // 20 in 7d saturates the second.
    expect(features(reviewer({ reviewsLast7d: 20 }))['beh.velocity']).toBe(1);
    // A single review over a dormant peer level is barely above zero.
    expect(features(reviewer({}) as never)['beh.velocity']).toBeLessThan(0.35);
  });

  it('scored velocity via peer ratio with acceleration', () => {
    const calm = features(reviewer({}), { peer: { medianReviewsPerDay: 0.5 } });
    const fast = features(reviewer({ reviewsLast24h: 4 }), { peer: { medianReviewsPerDay: 0.5 } });
    expect(fast['beh.velocity']).toBeGreaterThan(calm['beh.velocity']);
  });

  it('needs >= 5 item reviews for the rating deviation', () => {
    const profile = undefined;
    const item = { id: 'i', totalReviews: 4, averageRating: 2 } as never;
    expect(features(profile, { item })['beh.ratingDeviation']).toBe(0);
    const more = { id: 'i', totalReviews: 10, averageRating: 2 } as never;
    // |4 - 2| / 2 = 1
    expect(features(profile, { item: more })['beh.ratingDeviation']).toBe(1);
  });

  it('derives low entropy from an explicit ratingEntropy field', () => {
    const f = features(reviewer({ ratingEntropy: 1 }) as never);
    expect(f['beh.lowEntropy']).toBeCloseTo(1 - 1 / Math.log2(5), 8);
  });

  it('derives entropy from a ratingDistribution', () => {
    const uniform = features(reviewer({ ratingDistribution: [1, 1, 1, 1, 1] }));
    expect(uniform['beh.ratingEntropy']).toBe(1);
    expect(uniform['beh.lowEntropy']).toBeCloseTo(0, 10);

    const locked = features(reviewer({ ratingDistribution: [0, 0, 0, 0, 20] }));
    expect(locked['beh.ratingEntropy']).toBe(0);
    expect(locked['beh.lowEntropy']).toBe(1);
  });

  it('lowEntropy stays 0 when neither distribution nor explicit entropy exists', () => {
    expect(features(reviewer({}))['beh.lowEntropy']).toBe(0);
  });

  it('gives explicit ratingDistribution precedence over ratingDistribution[4]/total', () => {
    const fiveStar = features(
      reviewer({ fiveStarRatio: 0.95, ratingDistribution: [1, 0, 0, 0, 0] }),
    );
    expect(fiveStar['beh.fiveStarRatio']).toBe(0.95);
  });

  it('derives the five-star ratio from the distribution when absent', () => {
    const f = features(reviewer({ ratingDistribution: [1, 1, 1, 1, 16] }));
    expect(f['beh.fiveStarRatio']).toBeCloseTo(0.8, 10);
  });

  it('scales prior flags, category hopping, appeals overturned, and shared counts', () => {
    const f = features(
      reviewer({
        priorFlags: 6,
        categoryEntropy: 9,
        priorAppealsOverturned: 9,
        sharedDeviceCount: 25,
        sharedSubnetCount: 40,
      }),
    );
    expect(f['beh.priorFlags']).toBe(1);
    expect(f['beh.categoryHopping']).toBe(1);
    expect(f['beh.appealsOverturned']).toBe(1);
    expect(f['beh.sharedDeviceCount']).toBe(1);
    expect(f['beh.sharedSubnetCount']).toBe(1);
  });

  it('flags unverified purchases', () => {
    expect(features(undefined, {}, review({ verifiedPurchase: false }))['beh.unverified']).toBe(1);
    expect(features(undefined, {}, review({ verifiedPurchase: true }))['beh.unverified']).toBe(0);
    expect(features(undefined, {}, review())['beh.unverified']).toBe(0);
  });

  it('computes days since last review against `now`, clamped into [0,1]', () => {
    const f = features(reviewer({ lastReviewAt: '2026-10-23T10:00:00.000Z' }), { now: NOW });
    expect(f['beh.daysSinceLastReview']).toBeCloseTo(1 / 365, 8);

    const yearsAgo = features(reviewer({ lastReviewAt: '2020-10-23T10:00:00.000Z' }), { now: NOW });
    // The CV feature saturates; older reviews cannot exceed 1.
    expect(yearsAgo['beh.daysSinceLastReview']).toBe(1);
  });
});
