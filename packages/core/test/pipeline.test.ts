import { describe, expect, it } from 'vitest';
import type { AnalysisContext, CanonicalReview } from '../src';
import { analyzeReview, getPolicyPreset } from '../src';

const now = '2026-10-24T12:00:00Z';

const genuine: CanonicalReview = {
  id: 'genuine-1',
  itemId: 'item-1',
  reviewerId: 'reviewer-1',
  rating: 4,
  text: 'I bought this for my workshop three weeks ago. The 12mm chuck holds bits securely and the battery lasted about 4 hours on a full charge. It is heavier than my old drill, but the extra power is worth it. The case feels cheap, though.',
  submittedAt: '2026-10-23T18:20:00Z',
  verifiedPurchase: true,
  context: { locale: 'en-US', timezone: 'America/Los_Angeles' },
};

const genuineContext: AnalysisContext = {
  reviewer: {
    id: 'reviewer-1',
    accountCreatedAt: '2022-01-10T00:00:00Z',
    totalReviews: 34,
    reviewsLast24h: 1,
    reviewsLast7d: 2,
    reviewsLast30d: 6,
    ratingDistribution: [2, 2, 6, 12, 12],
    ratingEntropy: 1.4,
    fiveStarRatio: 0.35,
    verifiedPurchaseRatio: 0.9,
    sharedDeviceCount: 0,
    sharedSubnetCount: 1,
    recentIntervalsSeconds: [86400, 172800, 259200, 345600, 432000],
  },
  item: {
    id: 'item-1',
    totalReviews: 240,
    averageRating: 4.2,
    ratingDistribution: [12, 16, 30, 70, 112],
    recentReviews24h: 4,
    expectedReviewsPerDay: 5,
    baselineDistribution: [0.05, 0.07, 0.13, 0.3, 0.45],
    baselineMean: 4.1,
  },
  corpus: { totalReviews: 1200 },
  peer: { medianReviewsPerDay: 0.6 },
  now,
};

const duplicate: CanonicalReview = {
  id: 'dupe-2',
  itemId: 'item-1',
  reviewerId: 'reviewer-2',
  rating: 5,
  text: 'Best product ever!!! Works perfectly and the quality is amazing. Highly recommend to everyone!',
  submittedAt: '2026-10-24T11:55:00Z',
  verifiedPurchase: false,
  context: { locale: 'en-US' },
};

const duplicateContext: AnalysisContext = {
  reviewer: {
    id: 'reviewer-2',
    accountCreatedAt: '2026-10-24T10:00:00Z',
    totalReviews: 1,
    reviewsLast24h: 5,
    reviewsLast7d: 5,
    reviewsLast30d: 5,
    sharedDeviceCount: 4,
    sharedSubnetCount: 20,
    recentIntervalsSeconds: [12, 18, 22, 15],
    recentReviewTimestamps: [
      '2026-10-24T11:50:00Z',
      '2026-10-24T11:52:00Z',
      '2026-10-24T11:54:00Z',
      '2026-10-24T11:55:00Z',
    ],
  },
  item: {
    id: 'item-1',
    totalReviews: 240,
    averageRating: 4.2,
    ratingDistribution: [12, 16, 30, 70, 112],
    recentReviews24h: 40,
    expectedReviewsPerDay: 5,
    baselineDistribution: [0.05, 0.07, 0.13, 0.3, 0.45],
  },
  corpus: { totalReviews: 1200 },
  textMatches: [
    {
      reviewId: 'dupe-1',
      reviewerId: 'reviewer-3',
      itemId: 'item-1',
      similarity: 1,
      kind: 'exact',
      submittedAt: '2026-10-24T11:54:00Z',
    },
  ],
  peer: { medianReviewsPerDay: 0.6 },
  now,
};

describe('analysis pipeline', () => {
  it('keeps a detailed, established reviewer in the low band', () => {
    const result = analyzeReview(genuine, genuineContext, { now });
    expect(result.score).toBeLessThan(0.55);
    expect(['allow', 'label']).toContain(result.decision);
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.confidence).toBeGreaterThan(0.4);
  });

  it('flags exact duplicate text across accounts', () => {
    const result = analyzeReview(duplicate, duplicateContext, { now });
    expect(result.score).toBeGreaterThanOrEqual(0.9);
    expect(['hold', 'escalate']).toContain(result.decision);
    expect(
      result.reasons.some((reason) => reason.code === 'TEXT_EXACT_DUPLICATE_CROSS_ACCOUNT'),
    ).toBe(true);
    expect(result.signals.some((signal) => signal.hard === true)).toBe(true);
  });

  it('respects detector disablement', () => {
    const policy = getPolicyPreset('balanced');
    policy.disabledDetectors = ['duplicate', 'text-authenticity'];
    const result = analyzeReview(duplicate, duplicateContext, { now, policy });
    expect(result.signals.some((signal) => signal.family === 'content')).toBe(false);
  });

  it('produces stable timings and model metadata', () => {
    const result = analyzeReview(genuine, genuineContext, { now });
    expect(result.modelVersion).toBe('2026.10.1');
    expect(result.policyVersion).toBe('1.1.0');
    expect(result.timings.total).toBeGreaterThanOrEqual(0);
  });
});
