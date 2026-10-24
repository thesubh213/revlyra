import { describe, expect, it } from 'vitest';
import { computeBimodality, extractRatingFeatures } from '../src';
import type { ItemProfile } from '../src/types';

function item(overrides: Partial<ItemProfile>): ItemProfile {
  return { id: 'i', ...overrides } as ItemProfile;
}

describe('extractRatingFeatures', () => {
  it('returns the zero block when the distribution is unusable', () => {
    const expectedKeys = [
      'rating.sampleSize',
      'rating.excessFiveStar',
      'rating.chiSquare',
      'rating.chiSeverity',
      'rating.bimodality',
      'rating.meanShift',
      'rating.distributionAnomaly',
    ];
    for (const f of [
      extractRatingFeatures(undefined),
      extractRatingFeatures(item({})),
      extractRatingFeatures(item({ ratingDistribution: [] })),
      extractRatingFeatures(item({ ratingDistribution: [0, 0, 0, 0, 0] })),
    ]) {
      for (const key of expectedKeys) {
        expect(f[key]).toBe(0);
      }
      expect(Object.keys(f)).toEqual(expect.arrayContaining(expectedKeys));
    }
  });

  it('reports sample size and observed/baseline means for a valid distribution', () => {
    const f = extractRatingFeatures(item({ ratingDistribution: [2, 2, 2, 2, 12] }));
    expect(f['rating.sampleSize']).toBe(20);
    expect(f['rating.observedMean']).toBeCloseTo((2 + 4 + 6 + 8 + 60) / 20, 8);
    expect(f['rating.baselineMean']).toBeCloseTo(0.05 + 0.1 + 0.3 + 0.8 + 3, 8);
  });

  it('uses the generic J-shaped baseline by default', () => {
    const f = extractRatingFeatures(item({ ratingDistribution: [1, 0, 0, 0, 9] }));
    expect(f['rating.excessFiveStar']).toBeCloseTo(0.9 - 0.6, 8);
  });

  it('honors a learned baseline distribution', () => {
    const f = extractRatingFeatures(
      item({
        ratingDistribution: [0, 10, 0, 0, 40],
        baselineDistribution: [0, 0.8, 0, 0, 0.2],
      }),
    );
    expect(f['rating.excessFiveStar']).toBeCloseTo(0.8 - 0.2, 8);
  });

  it('falls back to generic baseline for zero-total custom baselines', () => {
    const zero = extractRatingFeatures(
      item({
        ratingDistribution: [0, 0, 0, 0, 5],
        baselineDistribution: [0, 0, 0, 0, 0],
      }),
    );
    expect(zero['rating.excessFiveStar']).toBeCloseTo(1 - 0.6, 8);
  });

  it('clamps negative counts inside the custom baseline normalization', () => {
    const f = extractRatingFeatures(
      item({
        ratingDistribution: [0, 0, 0, 0, 5],
        baselineDistribution: [-5, 0, 0, 0, 5],
      }),
    );
    // normalized baseline after clamping: [0,0,0,0,1]
    expect(f['rating.excessFiveStar']).toBeCloseTo(1 - 1, 8);
  });

  it('grades chi severity thresholds (7.78 / 9.49 / 13.28)', () => {
    // With all reviews in the 5-star bucket and a J-shaped generic baseline,
    // chi = n * 2/3. So n = 12 -> 8.0 (severity 0.4), n = 15 -> 10.0 (0.7),
    // n = 20 -> 13.33 (1).
    const mk = (n: number) => extractRatingFeatures(item({ ratingDistribution: [0, 0, 0, 0, n] }));
    expect(mk(10)['rating.chiSeverity']).toBe(0);
    expect(mk(12)['rating.chiSeverity']).toBe(0.4);
    expect(mk(15)['rating.chiSeverity']).toBe(0.7);
    expect(mk(20)['rating.chiSeverity']).toBe(1);
  });

  it('computes meanShift in standard-error units', () => {
    const f = extractRatingFeatures(item({ ratingDistribution: [1, 0, 0, 0, 99] }));
    // observed mean 4.98, std dev small -> huge shift, clamped at 1.
    expect(f['rating.meanShift']).toBeCloseTo(1, 8);
  });

  it('aggregates the anomaly from the strongest component', () => {
    const f = extractRatingFeatures(item({ ratingDistribution: [0, 0, 0, 0, 100] }));
    expect(f['rating.distributionAnomaly']).toBe(1);
  });
});

describe('computeBimodality', () => {
  it('is 0 for degenerate inputs', () => {
    expect(computeBimodality([])).toBe(0);
    expect(computeBimodality([1])).toBe(0);
    expect(computeBimodality([0, 0, 0, 1])).toBe(0);
    expect(computeBimodality([1, 0, 0, 0, 0])).toBe(0);
  });

  it('is higher for a J shape than for a uniform mix', () => {
    const jShape = computeBimodality([0.35, 0.05, 0.05, 0.05, 0.5]);
    const uniform = computeBimodality([0.2, 0.2, 0.2, 0.2, 0.2]);
    expect(jShape).toBeGreaterThan(uniform);
    expect(jShape).toBeGreaterThan(0);
  });

  it('is capped at 1.5', () => {
    expect(computeBimodality([0.5, 0.01, 0.01, 0.01, 0.47])).toBeLessThanOrEqual(1.5);
  });
});
