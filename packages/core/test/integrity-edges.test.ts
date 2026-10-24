import { describe, expect, it } from 'vitest';
import { computeIntegrity } from '../src';
import type { IntegrityInputReview } from '../src/types';

function reviewOf(overrides: Partial<IntegrityInputReview> & { id: string }): IntegrityInputReview {
  return {
    rating: 4,
    submittedAt: '2026-10-01T00:00:00.000Z',
    trustScore: 0.9,
    decision: 'allow',
    ...overrides,
  };
}

const NOW = '2026-10-24T00:00:00.000Z';

describe('computeIntegrity decision weights', () => {
  it('overweight allow, 0.8 label, 0.25 downrank, 0 for hold/remove/escalate', () => {
    const reviews = [
      reviewOf({ id: 'allow1', trustScore: 1, rating: 5, decision: 'allow' }),
      reviewOf({ id: 'label1', trustScore: 1, rating: 5, decision: 'label' }),
      reviewOf({ id: 'down1', trustScore: 1, rating: 1, decision: 'downrank' }),
      reviewOf({ id: 'held1', trustScore: 1, rating: 1, decision: 'hold' }),
    ];
    const result = computeIntegrity(reviews, { now: NOW, recencyHalfLifeDays: 0 });
    expect(result.includedCount).toBe(3);
    // weighted mean of (5, 5*0.8, 1*0.25) = (5 + 4 + 0.25)/2.05 = 4.512...
    expect(result.adjustedRating).toBeGreaterThan(4);
    expect(result.rawRating).toBeCloseTo((5 + 5 + 1 + 1) / 4, 3);
    // held reviews still count in the rating distribution
    expect(result.distribution['1']).toBe(2);
  });

  it('never lets held reviews hold the entire weight sum (all-zero weights)', () => {
    const reviews = [
      reviewOf({ id: 'h1', decision: 'hold' }),
      reviewOf({ id: 'h2', decision: 'hold' }),
    ];
    const result = computeIntegrity(reviews, { now: NOW });
    expect(result.adjustedRating).toBeCloseTo(4.2, 3);
    expect(result.includedCount).toBe(0);
    expect(result.reviewCount).toBe(2);
  });

  it('counts fractional ratings into rounded buckets but raw sums raw', () => {
    const result = computeIntegrity(
      [reviewOf({ id: 'a', rating: 4.6 }), reviewOf({ id: 'b', rating: 1.4 })],
      { now: NOW, recencyHalfLifeDays: 0 },
    );
    expect(result.distribution).toEqual({ '1': 1, '2': 0, '3': 0, '4': 0, '5': 1 });
    expect(result.rawRating).toBeCloseTo(3, 3);
  });
});

describe('computeIntegrity chi square gate', () => {
  it('is null below 30 reviews and numeric at 30+', () => {
    const reviewsBelow = Array.from({ length: 29 }, (_, i) => reviewOf({ id: `b${i}`, rating: 5 }));
    expect(computeIntegrity(reviewsBelow, { now: NOW }).chiSquare).toBeNull();
    const reviewsAbove = Array.from({ length: 30 }, (_, i) => reviewOf({ id: `a${i}`, rating: 5 }));
    expect(computeIntegrity(reviewsAbove, { now: NOW }).chiSquare).not.toBeNull();
  });
});

describe('computeIntegrity baselines', () => {
  it('accepts the object-keyed form of baselineDistribution', () => {
    const result = computeIntegrity([reviewOf({ id: 'a', rating: 5 })], {
      now: NOW,
      baselineDistribution: { '1': 0.5, '2': 0.1, '3': 0.1, '4': 0.1, '5': 0.2 },
    });
    expect(result.baselineDistribution).toEqual({
      '1': 0.5,
      '2': 0.1,
      '3': 0.1,
      '4': 0.1,
      '5': 0.2,
    });
    expect(result.excessFiveStar).toBeCloseTo(1 - 0.2, 3);
  });

  it('falls back to generic baseline for malformed arrays', () => {
    const short = computeIntegrity([reviewOf({ id: 'a' })], {
      now: NOW,
      baselineDistribution: [0.5, 0.5],
    });
    expect(short.baselineDistribution).toEqual({
      '1': 0.05,
      '2': 0.05,
      '3': 0.1,
      '4': 0.2,
      '5': 0.6,
    });
  });

  it('falls back for zero-total baselines', () => {
    const zero = computeIntegrity([reviewOf({ id: 'a' })], {
      now: NOW,
      baselineDistribution: [0, 0, 0, 0, 0],
    });
    expect(zero.baselineDistribution['5']).toBe(0.6);
  });
});

describe('computeIntegrity distribution signals', () => {
  it('computes allPositiveSuspicion only at >= 20 reviews with no critical ratings', () => {
    const nineteen = Array.from({ length: 19 }, (_, i) => reviewOf({ id: `n${i}`, rating: 5 }));
    expect(computeIntegrity(nineteen, { now: NOW }).distributionSignals.allPositiveSuspicion).toBe(
      false,
    );
    const twenty = Array.from({ length: 20 }, (_, i) => reviewOf({ id: `t${i}`, rating: 5 }));
    expect(computeIntegrity(twenty, { now: NOW }).distributionSignals.allPositiveSuspicion).toBe(
      true,
    );
    const mixed = [
      ...Array.from({ length: 20 }, (_, i) => reviewOf({ id: `m${i}`, rating: 5 })),
      reviewOf({ id: 'crit', rating: 2 }),
    ];
    expect(computeIntegrity(mixed, { now: NOW }).distributionSignals.allPositiveSuspicion).toBe(
      false,
    );
  });

  it('polarization-index math clamps at 1; shares ignore unknown verified state', () => {
    const reviews = [
      reviewOf({ id: 'a', rating: 1, verifiedPurchase: true }),
      reviewOf({ id: 'b', rating: 5, verifiedPurchase: false }),
      reviewOf({ id: 'c', rating: 5 }),
      reviewOf({ id: 'd', rating: 5 }),
    ];
    const result = computeIntegrity(reviews, { now: NOW, recencyHalfLifeDays: 0 });
    // observed = [0.25, 0, 0, 0, 0.75] -> p5 + p1 - max(p2,p3,p4) = 1.0
    expect(result.distributionSignals.polarizationIndex).toBeCloseTo(1, 3);
    expect(result.distributionSignals.verifiedShare).toBeCloseTo(0.5, 3);
    expect(result.distributionSignals.positiveRatio).toBeCloseTo(0.75, 3);
  });

  it('median age days only counts reviews with submittedAt', () => {
    const result = computeIntegrity(
      [
        reviewOf({ id: 'a', submittedAt: '2026-10-20T00:00:00.000Z' }),
        reviewOf({ id: 'b', submittedAt: '2026-09-01T00:00:00.000Z' }),
        reviewOf({ id: 'c', submittedAt: undefined } as never),
      ],
      { now: NOW },
    );
    // ages: 4 and 53 days -> median 28.5
    expect(result.distributionSignals.medianAgeDays).toBeCloseTo(28.5, 1);
  });

  it('recentWeightedShare90d is 0 when nothing is recent', () => {
    const result = computeIntegrity(
      [reviewOf({ id: 'a', submittedAt: '2020-01-01T00:00:00.000Z' })],
      { now: NOW },
    );
    expect(result.distributionSignals.recencyWeightedShare90d).toBe(0);
  });
});

describe('computeIntegrity confidence bounds and concerns', () => {
  it('derives wide confidence intervals on weak data', () => {
    const result = computeIntegrity([reviewOf({ id: 'a', rating: 2, trustScore: 0.5 })], {
      now: NOW,
    });
    expect(result.confidenceLow).toBeGreaterThanOrEqual(1);
    expect(result.confidenceHigh).toBeLessThanOrEqual(5);
    expect(result.confidenceHigh).toBeGreaterThan(result.confidenceLow);
  });

  it('aggregates top concerns by frequency', () => {
    const result = computeIntegrity(
      [
        reviewOf({ id: 'a', concerns: ['X', 'Y'] } as never),
        reviewOf({ id: 'b', concerns: ['X'] } as never),
        reviewOf({ id: 'c', concerns: ['X', 'Z'] } as never),
        reviewOf({ id: 'd', concerns: ['Q'] } as never),
        reviewOf({ id: 'e', concerns: ['Q'] } as never),
        reviewOf({ id: 'f', concerns: ['Q'] } as never),
        reviewOf({ id: 'g', concerns: ['R', 'S', 'T', 'U'] } as never),
      ],
      { now: NOW },
    );
    expect(result.topConcerns[0]).toBe('X (3)');
    expect(result.topConcerns[1]).toBe('Q (3)');
    expect(result.topConcerns.length).toBeLessThanOrEqual(5);
  });

  it('empty input yields the prior mean and empty fields', () => {
    const result = computeIntegrity([], { now: NOW });
    expect(result.rawRating).toBe(0);
    expect(result.adjustedRating).toBe(4.2);
    expect(result.reviewCount).toBe(0);
    expect(result.suspicionRate).toBe(0);
    expect(result.distributionSignals.modeStars).toBe(0);
    expect(result.distributionSignals.medianAgeDays).toBeNull();
  });
});
