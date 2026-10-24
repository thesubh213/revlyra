import { describe, expect, it } from 'vitest';
import { extractTemporalFeatures, normalCdf, poissonSurprise, poissonSurvival } from '../src';
import type { AnalysisContext, CanonicalReview } from '../src/types';

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

function features(analysis: Partial<AnalysisContext> = {}, r = review()) {
  return extractTemporalFeatures(r, { now: NOW, ...analysis });
}

describe('normalCdf', () => {
  it('maps 0 to 0.5 and large values to 0/1 (A&S approximation error ~5e-10)', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 8);
    expect(normalCdf(37)).toBeCloseTo(1, 7);
    expect(normalCdf(-37)).toBeCloseTo(0, 7);
  });

  it('is symmetric', () => {
    expect(normalCdf(1) + normalCdf(-1)).toBeCloseTo(1, 10);
    expect(normalCdf(2) + normalCdf(-2)).toBeCloseTo(1, 10);
  });

  it('matches reference z-values', () => {
    expect(normalCdf(1)).toBeCloseTo(0.8413, 4);
    expect(normalCdf(-1)).toBeCloseTo(0.1587, 4);
    expect(normalCdf(2)).toBeCloseTo(0.9772, 4);
  });
});

describe('poissonSurvival / poissonSurprise', () => {
  it('returns 1 for non-positive k or non-positive lambda', () => {
    expect(poissonSurvival(0, 3)).toBe(1);
    expect(poissonSurvival(2, 0)).toBe(1);
    expect(poissonSurvival(2, -1)).toBe(1);
    expect(poissonSurvival(2, Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('matches exact Poisson tails for small lambda', () => {
    // P(X >= 5), lambda 1
    expect(poissonSurvival(5, 1)).toBeCloseTo(0.0036598468, 5);
    expect(poissonSurprise(5, 1)).toBeCloseTo(-Math.log10(0.0036598468), 4);
    // P(X >= 1), lambda 10: 1 - e^-10
    expect(poissonSurvival(1, 10)).toBeCloseTo(1 - Math.exp(-10), 8);
  });

  it('surprise is 0 at survival 1 (log10 of unity)', () => {
    expect(poissonSurprise(0, 5)).toBeCloseTo(0, 12);
  });

  it('uses the normal approximation above lambda 30 and clamps away from exactly 0', () => {
    const survival = poissonSurvival(200, 30);
    expect(survival).toBeGreaterThan(0);
    expect(poissonSurprise(200, 30)).toBeLessThan(12.1);
    // Extreme case clamped at 1e-12.
    const extreme = poissonSurprise(200, 5);
    expect(extreme).toBeCloseTo(12, 8);
  });
});

describe('extractTemporalFeatures', () => {
  it('surprise is 0 without a burst baseline or recent reviews', () => {
    expect(features({})['temp.burst']).toBe(0);
    expect(features({ item: { id: 'i', expectedReviewsPerDay: 0.2 } as never })['temp.burst']).toBe(
      0,
    );
  });

  it('computes burst surprise when >= 3 recent reviews exist against a baseline', () => {
    const item = { id: 'i', expectedReviewsPerDay: 0.3, recentReviews24h: 12 } as never;
    const f = features({ item });
    expect(f['temp.hasBurstBaseline']).toBe(1);
    expect(f['temp.burstSurprise']).toBeGreaterThan(0);
    expect(f['temp.burst']).toBeGreaterThan(0);
    expect(f['temp.burst']).toBeLessThanOrEqual(1);
  });

  it('requires >= 5 intervals before flagging low inter-arrival CV', () => {
    const four = { reviewer: { id: 'r', recentIntervalsSeconds: [60, 60, 60, 60] } } as never;
    expect(features(four)['temp.lowInterArrivalCv']).toBe(0);
    expect(features(four)['temp.hasIntervals']).toBe(0);

    const five = {
      reviewer: { id: 'r', recentIntervalsSeconds: [59, 60, 60, 60, 61] },
    } as never;
    const f = features(five);
    expect(f['temp.hasIntervals']).toBe(1);
    // CV = ~0.012 -> 1 - cv/0.3 ~ 0.96
    expect(f['temp.lowInterArrivalCv']).toBeGreaterThan(0.9);
  });

  it('flags impossible intervals below 30 seconds', () => {
    const f = features({
      reviewer: { id: 'r', recentIntervalsSeconds: [10, 60, 90] },
    } as never);
    expect(f['temp.impossibleIntervals']).toBe(1);
    expect(f['temp.minIntervalSeconds']).toBe(10);
  });

  it('handles empty intervals gracefully', () => {
    const f = features({} as never);
    expect(f['temp.minIntervalSeconds']).toBe(0);
    expect(f['temp.impossibleIntervals']).toBe(0);
    expect(f['temp.interArrivalCv']).toBe(1);
  });

  it('ignores non-finite interval values', () => {
    const f = features({
      reviewer: { id: 'r', recentIntervalsSeconds: [Number.NaN, Number.POSITIVE_INFINITY, 45] },
    } as never);
    expect(f['temp.minIntervalSeconds']).toBe(45);
    expect(f['temp.impossibleIntervals']).toBe(0);
  });

  it('counts timestamps posted within +/- 10 minutes (at least 3 to trigger sync)', () => {
    const base = new Date(NOW).getTime();
    const start = 10 * 60 * 1000;
    const stagger = 5 * 60 * 1000;
    const timestamps = [
      new Date(base - stagger).toISOString(),
      new Date(base).toISOString(),
      new Date(base).toISOString(),
      new Date(base).toISOString(),
    ];
    const two = {
      reviewer: { id: 'r', recentReviewTimestamps: timestamps.slice(0, 2) },
    } as never;
    expect(features(two)['temp.sync']).toBe(0);

    const five = {
      reviewer: {
        id: 'r',
        recentReviewTimestamps: Array.from({ length: 8 }, () => new Date(base).toISOString()),
      },
    } as never;
    expect(features(five)['temp.sync']).toBeCloseTo(1, 8);

    void start;
  });

  it('ignores timestamps far from the submission or unparseable', () => {
    const base = new Date(NOW).getTime();
    const f = features({
      reviewer: {
        id: 'r',
        recentReviewTimestamps: ['not-a-date', new Date(base - 20 * 60 * 1000).toISOString()],
      },
    } as never);
    expect(f['temp.syncCount']).toBe(0);
  });

  it('flags impossible inter-arrival data still dominant', () => {
    const f = features({
      reviewer: { id: 'r', recentIntervalsSeconds: [1200, 1200, 1200] },
    } as never);
    expect(f['temp.impossibleIntervals']).toBe(0);
  });

  it('flags odd UTC hours between 2 and 5 inclusive', () => {
    const at3 = features({}, review({ submittedAt: '2026-10-24T03:30:00.000Z' }));
    expect(at3['temp.oddHour']).toBe(1);
    const at14 = features({}, review({ submittedAt: '2026-10-24T14:30:00.000Z' }));
    expect(at14['temp.oddHour']).toBe(0);
    const at2 = features({}, review({ submittedAt: '2026-10-24T02:00:00.000Z' }));
    expect(at2['temp.oddHour']).toBe(1);
    const at6 = features({}, review({ submittedAt: '2026-10-24T06:00:00.000Z' }));
    expect(at6['temp.oddHour']).toBe(0);
  });

  it('honors the item localTimezone when given', () => {
    // 22:00 UTC is 03:30 IST in Asia/Kolkata (+5:30 next day) -> odd hour.
    const f = features(
      { item: { id: 'i', localTimezone: 'Asia/Kolkata' } as never },
      review({ submittedAt: '2026-10-24T22:00:00.000Z' }),
    );
    expect(f['temp.hourOfDay']).toBe(3);
    expect(f['temp.oddHour']).toBe(1);
    // 16:00 UTC is 21:30 IST -> not odd.
    const evening = features(
      { item: { id: 'i', localTimezone: 'Asia/Kolkata' } as never },
      review({ submittedAt: '2026-10-24T16:00:00.000Z' }),
    );
    expect(evening['temp.hourOfDay']).toBe(21);
    expect(evening['temp.oddHour']).toBe(0);
  });

  it('falls back to UTC hours for invalid timezones', () => {
    const f = features(
      { item: { id: 'i', localTimezone: 'Mars/Olympus' } as never },
      review({ submittedAt: '2026-10-24T03:30:00.000Z' }),
    );
    expect(f['temp.hourOfDay']).toBe(3);
    expect(f['temp.oddHour']).toBe(1);
  });

  it('marks weekend submissions by UTC day', () => {
    expect(
      features({}, review({ submittedAt: '2026-10-24T10:00:00.000Z' }))['temp.isWeekend'],
    ).toBe(1);
    expect(
      features({}, review({ submittedAt: '2026-10-20T10:00:00.000Z' }))['temp.isWeekend'],
    ).toBe(0);
  });

  it('flags reviews within an hour of account creation', () => {
    const f = features(
      { reviewer: { id: 'r', accountCreatedAt: '2026-10-24T09:35:00.000Z' } } as never,
      review({ submittedAt: '2026-10-24T10:00:00.000Z' }),
    );
    expect(f['temp.reviewWithinHourOfSignup']).toBe(1);
    expect(f['temp.ageHours']).toBeCloseTo(25 / 60, 8);

    const older = features({
      reviewer: { id: 'r', accountCreatedAt: '2026-10-24T00:00:00.000Z' },
    } as never);
    expect(older['temp.reviewWithinHourOfSignup']).toBe(0);

    const futureCreated = features({
      reviewer: { id: 'r', accountCreatedAt: '2026-10-25T00:00:00.000Z' },
    } as never);
    expect(futureCreated['temp.reviewWithinHourOfSignup']).toBe(0);
    expect(futureCreated['temp.ageHours']).toBeLessThan(0);
  });

  it('reports a non-negative submitted age in years, clamped', () => {
    const f = features({}, review({ submittedAt: '2020-01-01T00:00:00.000Z' }));
    const days = (Date.now() - new Date('2020-01-01T00:00:00.000Z').getTime()) / 86_400_000;
    expect(f['temp.submittedAgeDays']).toBeCloseTo(Math.min(1, days / 3650), 8);
  });
});
