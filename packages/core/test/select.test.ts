import { describe, expect, it } from 'vitest';
import type { ScoredReviewInput } from '../src';
import { computeIntegrity, selectReviews } from '../src/select';

const base = {
  rating: 5,
  submittedAt: '2026-10-20T00:00:00Z',
  trustScore: 0.9,
  decision: 'allow' as const,
};

describe('review selector', () => {
  it('collapses near-duplicates and keeps diverse reviews', () => {
    const reviews: ScoredReviewInput[] = [
      {
        ...base,
        id: 'a',
        text: 'The battery lasts eight hours and the screen is bright. The charger is compact.',
      },
      {
        ...base,
        id: 'b',
        text: 'The battery lasts eight hours and the screen is bright. The charger is compact!',
      },
      {
        ...base,
        id: 'c',
        text: 'Shipping was slow and the box arrived damaged, but support replaced it in two days.',
        trustScore: 0.75,
        rating: 3,
      },
      {
        ...base,
        id: 'd',
        text: 'This is a very bad product and I regret buying it.',
        trustScore: 0.2,
        decision: 'hold',
        rating: 1,
      },
    ];

    const result = selectReviews(reviews, { limit: 3, minTrust: 0.5 });
    expect(result.clusters).toBe(2);
    expect(result.reviews.map((review) => review.id).sort()).toEqual(['a', 'c']);
    expect(result.excluded).toBe(2);
  });

  it('excludes flagged reviews unless requested', () => {
    const flagged: ScoredReviewInput = {
      ...base,
      id: 'flagged',
      text: 'Buy now, best product ever, five stars!',
      decision: 'remove',
      trustScore: 0.1,
    };
    expect(selectReviews([flagged]).reviews).toHaveLength(0);
    expect(selectReviews([flagged], { includeFlagged: true }).reviews).toHaveLength(1);
  });
});

describe('integrity score', () => {
  it('raises the rating when suspicious low ratings are excluded', () => {
    const result = computeIntegrity(
      [
        { rating: 5, trustScore: 0.95, decision: 'allow', concerns: ['TEXT_GENERIC'] },
        { rating: 5, trustScore: 0.9, decision: 'allow', concerns: ['TEXT_GENERIC'] },
        {
          rating: 1,
          trustScore: 0.9,
          decision: 'hold',
          concerns: ['TEXT_EXACT_DUPLICATE_CROSS_ACCOUNT'],
        },
      ],
      { priorMean: 4, priorWeight: 2 },
    );
    expect(result.rawRating).toBeCloseTo(3.667, 2);
    expect(result.adjustedRating).toBeGreaterThan(result.rawRating);
    expect(result.suspicionRate).toBeCloseTo(0.333, 2);
    expect(result.topConcerns[0]).toContain('TEXT_GENERIC');
  });

  it('handles empty input without NaN', () => {
    const result = computeIntegrity([]);
    expect(result.reviewCount).toBe(0);
    expect(Number.isFinite(result.adjustedRating)).toBe(true);
    expect(result.adjustedRating).toBe(4.2);
  });
});
