import { describe, expect, it } from 'vitest';
import {
  analysisContextSchema,
  analyzeRequestSchema,
  canonicalReviewSchema,
  itemProfileSchema,
  reviewContextSchema,
  reviewerProfileSchema,
  reviewerRelationshipSchema,
  reviewMediaSchema,
} from '../src/schemas/review';

function baseReview(overrides: Record<string, unknown> = {}) {
  return {
    itemId: 'item-1',
    reviewerId: 'user-1',
    rating: 4,
    text: 'solid drill, battery lasts four hours',
    submittedAt: '2026-10-24T10:00:00.000Z',
    ...overrides,
  };
}

describe('canonicalReviewSchema', () => {
  it('parses a minimal valid review with defaults', () => {
    const parsed = canonicalReviewSchema.parse(baseReview());
    expect(parsed.itemId).toBe('item-1');
    expect(parsed.media).toBeUndefined();
  });

  it('rejects missing identifiers and out-of-range ratings', () => {
    expect(() => canonicalReviewSchema.parse(baseReview({ itemId: '' }))).toThrow();
    expect(() => canonicalReviewSchema.parse(baseReview({ reviewerId: '' }))).toThrow();
    expect(() => canonicalReviewSchema.parse(baseReview({ rating: 0.5 }))).toThrow();
    expect(() => canonicalReviewSchema.parse(baseReview({ rating: 5.5 }))).toThrow();
    expect(() => canonicalReviewSchema.parse(baseReview({ rating: '4' }))).toThrow();
  });

  it('rejects text over 20,000 chars and tiny dates', () => {
    expect(() => canonicalReviewSchema.parse(baseReview({ text: 'x'.repeat(20_001) }))).toThrow();
    expect(() => canonicalReviewSchema.parse(baseReview({ submittedAt: 'next week' }))).toThrow();
    expect(canonicalReviewSchema.safeParse(baseReview({ text: 'x'.repeat(20_000) })).success).toBe(
      true,
    );
  });

  it('caps the media array at 50 entries', () => {
    const userMedia = Array.from({ length: 50 }, () => ({ url: 'https://x/y.jpg' }));
    expect(canonicalReviewSchema.safeParse(baseReview({ media: userMedia })).success).toBe(true);
    expect(canonicalReviewSchema.safeParse(baseReview({ media: [...userMedia, {}] })).success).toBe(
      false,
    );
  });

  it('enforces the reviewerRelationship enum', () => {
    expect(reviewerRelationshipSchema.safeParse('customer').success).toBe(true);
    expect(reviewerRelationshipSchema.safeParse('owner').success).toBe(true);
    expect(reviewerRelationshipSchema.safeParse('admin').success).toBe(false);
    expect(() =>
      canonicalReviewSchema.parse(baseReview({ reviewerRelationship: 'boss' })),
    ).toThrow();
  });

  it('validates media entries: bounds on hashes, dimensions, and timestamps', () => {
    expect(reviewMediaSchema.safeParse({}).success).toBe(true);
    expect(reviewMediaSchema.safeParse({ width: 0 }).success).toBe(false);
    expect(reviewMediaSchema.safeParse({ width: 100_001 }).success).toBe(false);
    expect(reviewMediaSchema.safeParse({ width: 1.5 }).success).toBe(false);
    expect(reviewMediaSchema.safeParse({ url: 'x'.repeat(2049) }).success).toBe(false);
    expect(reviewMediaSchema.safeParse({ capturedAt: 'not-a-date' }).success).toBe(false);
    expect(reviewMediaSchema.safeParse({ capturedAt: '2026-10-24T10:00:00Z' }).success).toBe(true);
  });
});

describe('reviewContextSchema', () => {
  it('accepts numeric or string ASN and booleans', () => {
    expect(reviewContextSchema.safeParse({ ipAsn: 13335 }).success).toBe(true);
    expect(reviewContextSchema.safeParse({ ipAsn: 'AS13335' }).success).toBe(true);
    expect(reviewContextSchema.safeParse({ isDatacenterAsn: true }).success).toBe(true);
    expect(reviewContextSchema.safeParse({ recentAccountsOnSubnet: -1 }).success).toBe(false);
    expect(reviewContextSchema.safeParse({ deviceId: 'x'.repeat(513) }).success).toBe(false);
    expect(reviewContextSchema.safeParse({ localeMismatch: 'yes' }).success).toBe(false);
  });
});

describe('reviewerProfileSchema / itemProfileSchema', () => {
  it('requires five-length distributions and bounded losses', () => {
    expect(
      reviewerProfileSchema.safeParse({ id: 'r', ratingDistribution: [1, 1, 1, 1, 1] }).success,
    ).toBe(true);
    expect(
      reviewerProfileSchema.safeParse({ id: 'r', ratingDistribution: [1, 1, 1] }).success,
    ).toBe(false);
    expect(
      reviewerProfileSchema.safeParse({ id: 'r', ratingDistribution: [-1, 1, 1, 1, 1] }).success,
    ).toBe(false);
    expect(
      itemProfileSchema.safeParse({ id: 'i', ratingDistribution: [0, 0, 0, 0, 10] }).success,
    ).toBe(true);
    expect(itemProfileSchema.safeParse({ id: 'i', baselineMean: 5.5 }).success).toBe(false);
    expect(itemProfileSchema.safeParse({ id: 'i', expectedReviewsPerDay: -0.1 }).success).toBe(
      false,
    );
  });

  it('validates iso timestamps and bounded counts', () => {
    expect(reviewerProfileSchema.safeParse({ id: 'r', accountCreatedAt: 'bad' }).success).toBe(
      false,
    );
    expect(reviewerProfileSchema.safeParse({ id: 'r', priorFlags: -2 }).success).toBe(false);
    expect(
      reviewerProfileSchema.safeParse({ id: 'r', recentIntervalsSeconds: [0.5] }).success,
    ).toBe(true);
    expect(
      reviewerProfileSchema.safeParse({
        id: 'r',
        recentIntervalsSeconds: Array.from({ length: 501 }, () => 60),
      }).success,
    ).toBe(false);
    expect(
      reviewerProfileSchema.safeParse({
        id: 'r',
        recentReviewTimestamps: Array.from({ length: 501 }, () => '2026-10-01T00:00:00Z'),
      }).success,
    ).toBe(false);
  });
});

describe('analysisContextSchema', () => {
  it('validates text/media matches, campaign hint, semantic bounds', () => {
    expect(
      analysisContextSchema.safeParse({
        textMatches: [
          { reviewId: 'x', reviewerId: 'y', itemId: 'z', similarity: 0.5, kind: 'near' },
        ],
      }).success,
    ).toBe(true);
    expect(
      analysisContextSchema.safeParse({
        textMatches: [
          { reviewId: 'x', reviewerId: 'y', itemId: 'z', similarity: 1.2, kind: 'near' },
        ],
      }).success,
    ).toBe(false);
    expect(
      analysisContextSchema.safeParse({
        textMatches: [
          { reviewId: 'x', reviewerId: 'y', itemId: 'z', similarity: 0.9, kind: 'unknown' },
        ],
      }).success,
    ).toBe(false);
    expect(
      analysisContextSchema.safeParse({
        mediaMatches: [
          { reviewId: 'x', reviewerId: 'y', itemId: 'z', kind: 'exact', distance: -1 },
        ],
      }).success,
    ).toBe(false);
    expect(
      analysisContextSchema.safeParse({
        campaign: { id: 'cmp_x', score: 0.5, memberCount: 3, signalFamilies: ['graph'] },
      }).success,
    ).toBe(true);
    expect(
      analysisContextSchema.safeParse({
        campaign: { id: 'cmp_x', score: 1.2, memberCount: 3, signalFamilies: ['graph'] },
      }).success,
    ).toBe(false);
    expect(
      analysisContextSchema.safeParse({
        semantic: { llmLikelihood: 0.9 },
      }).success,
    ).toBe(true);
    expect(
      analysisContextSchema.safeParse({
        semantic: { llmLikelihood: 2 },
      }).success,
    ).toBe(false);
  });

  it('caps match arrays at 100', () => {
    const matches = Array.from({ length: 101 }, (_, i) => ({
      reviewId: `o${i}`,
      reviewerId: 'z',
      itemId: 'q',
      similarity: 0.5,
      kind: 'near' as const,
    }));
    expect(analysisContextSchema.safeParse({ textMatches: matches }).success).toBe(false);
  });

  it('includes corpus and peer stat shapes', () => {
    expect(
      analysisContextSchema.safeParse({ corpus: { totalReviews: 50, tokenIdf: { a: 1 } } }).success,
    ).toBe(true);
    expect(analysisContextSchema.safeParse({ corpus: { totalReviews: '50' } }).success).toBe(false);
    expect(analysisContextSchema.safeParse({ peer: { medianReviewsPerDay: 0.5 } }).success).toBe(
      true,
    );
    expect(analysisContextSchema.safeParse({ now: 'not-a-date' }).success).toBe(false);
  });
});

describe('analyzeRequestSchema', () => {
  it('wraps a canonical review with optional context and policy', () => {
    expect(analyzeRequestSchema.safeParse({ review: baseReview() }).success).toBe(true);
    expect(analyzeRequestSchema.safeParse({ review: baseReview(), policy: 'strict' }).success).toBe(
      true,
    );
    expect(
      analyzeRequestSchema.safeParse({ review: baseReview(), policy: 'x'.repeat(101) }).success,
    ).toBe(false);
    expect(analyzeRequestSchema.safeParse({}).success).toBe(false);
  });
});
