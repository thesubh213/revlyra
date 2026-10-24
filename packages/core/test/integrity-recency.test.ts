import { describe, expect, it } from 'vitest';
import { computeIntegrity } from '../src';

const NOW = '2026-10-24T00:00:00Z';

function dayAgo(days: number): string {
  return new Date(Date.parse(NOW) - days * 86_400_000).toISOString();
}

describe('integrity recency + verification weighting', () => {
  it('decays old review weight with the documented half-life', () => {
    const fresh = computeIntegrity(
      [
        { rating: 5, trustScore: 1, decision: 'allow', submittedAt: dayAgo(10) },
        { rating: 1, trustScore: 1, decision: 'allow', submittedAt: dayAgo(30) },
      ],
      { recencyHalfLifeDays: 120, now: NOW },
    );
    const decayedOld = computeIntegrity(
      [
        { rating: 5, trustScore: 1, decision: 'allow', submittedAt: dayAgo(10) },
        { rating: 1, trustScore: 1, decision: 'allow', submittedAt: dayAgo(400) },
      ],
      { recencyHalfLifeDays: 120, now: NOW },
    );
    // Same ratings, but the 1★ review is now ~4× past the half-life.
    expect(decayedOld.adjustedRating).toBeGreaterThan(fresh.adjustedRating);
    // Without decay the 1★ drags the mean to ~2.90 (prior 4.2, C=10).
    const noDecay = computeIntegrity(
      [
        { rating: 5, trustScore: 1, decision: 'allow', submittedAt: dayAgo(10) },
        { rating: 1, trustScore: 1, decision: 'allow', submittedAt: dayAgo(400) },
      ],
      { recencyHalfLifeDays: 0, now: NOW },
    );
    expect(noDecay.adjustedRating).toBeLessThan(decayedOld.adjustedRating);
  });

  it('weights verified purchases higher and unverified lower', () => {
    const inputs = [
      {
        rating: 2,
        trustScore: 1,
        decision: 'allow' as const,
        submittedAt: dayAgo(5),
        verifiedPurchase: true,
      },
      {
        rating: 2,
        trustScore: 1,
        decision: 'allow' as const,
        submittedAt: dayAgo(5),
        verifiedPurchase: false,
      },
    ];
    const boosted = computeIntegrity(inputs, {
      verifiedBoost: 1.15,
      unverifiedFactor: 0.9,
      now: NOW,
    });
    const flat = computeIntegrity(inputs, { verifiedBoost: 1, unverifiedFactor: 1, now: NOW });
    // The verified 2★ weighs more, so the adjusted rating sits below the
    // unweighted average (prior pulls up to 2.90-ish; boost pulls further down).
    expect(boosted.adjustedRating).toBeLessThan(flat.adjustedRating);
  });

  it('exposes distributional transparency signals', () => {
    const reviews = Array.from({ length: 20 }, (_, index) => ({
      rating: 5,
      trustScore: 0.9,
      decision: 'allow' as const,
      submittedAt: dayAgo(index + 1),
      verifiedPurchase: index % 4 === 0,
    }));
    const result = computeIntegrity(reviews, { now: NOW });
    expect(result.distributionSignals.modeStars).toBe(5);
    expect(result.distributionSignals.allPositiveSuspicion).toBe(true);
    expect(result.distributionSignals.verifiedShare).toBeCloseTo(0.25, 2);
    expect(result.distributionSignals.polarizationIndex).toBeCloseTo(1, 2);
    // 10–20 days at a 120-day half-life keeps ~90% of the weight recent.
    expect(result.distributionSignals.recencyWeightedShare90d).toBeGreaterThan(0.8);
    expect(result.distributionSignals.medianAgeDays).toBeGreaterThan(0);
  });

  it('reports moderate signals on a J-shaped corpus with critical reviews present', () => {
    const counts = [10, 1, 2, 6, 21];
    const reviews = counts.flatMap((count, index) =>
      Array.from({ length: count }, () => ({
        rating: index + 1,
        trustScore: 0.85,
        decision: 'allow' as const,
        submittedAt: dayAgo(20),
      })),
    );
    const result = computeIntegrity(reviews, { now: NOW });
    expect(result.distributionSignals.allPositiveSuspicion).toBe(false);
    expect(result.distributionSignals.polarizationIndex).toBeGreaterThan(0.4);
    expect(result.distributionSignals.stdDev).toBeGreaterThan(1.4);
    expect(result.distributionSignals.criticalShare).toBeGreaterThan(0.3);
  });
});
