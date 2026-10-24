import type { AnalysisContext, CanonicalReview, FeatureSet } from '../types';
import { clamp } from './content';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

export function normalCdf(z: number): number {
  // Abramowitz & Stegun 7.1.26 approximation; max error ~1.5e-7.
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const poly =
    t *
    (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

export function poissonSurvival(k: number, lambda: number): number {
  if (k <= 0) return 1;
  if (!Number.isFinite(lambda) || lambda <= 0) return 1;

  if (lambda > 30 || k > 200) {
    const z = (k - 0.5 - lambda) / Math.sqrt(lambda);
    return clamp(1 - normalCdf(z), 1e-12, 1);
  }

  let cumulative = 0;
  let term = Math.exp(-lambda);
  for (let i = 0; i < k; i += 1) {
    if (i > 0) term *= lambda / i;
    cumulative += term;
  }
  return clamp(1 - cumulative, 1e-12, 1);
}

export function poissonSurprise(k: number, lambda: number): number {
  const survival = poissonSurvival(k, lambda);
  return -Math.log10(Math.max(survival, 1e-300));
}

function coefficientOfVariation(values: number[]): number {
  if (values.length < 2) return 1;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean <= 0) return 1;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

function localHour(iso: string, timeZone?: string): number | null {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  if (!timeZone) return date.getUTCHours();
  try {
    const formatted = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hour12: false,
      timeZone,
    }).format(date);
    const parsed = Number.parseInt(formatted, 10);
    return Number.isFinite(parsed) ? parsed % 24 : null;
  } catch {
    return date.getUTCHours();
  }
}

export function extractTemporalFeatures(
  review: CanonicalReview,
  analysis: AnalysisContext,
): FeatureSet {
  const submitted = new Date(review.submittedAt);
  const submittedMs = submitted.getTime();
  const item = analysis.item;
  const expectedPerDay = item?.expectedReviewsPerDay;
  const recent24h = item?.recentReviews24h ?? 0;

  let burstSurprise = 0;
  if (expectedPerDay !== undefined && expectedPerDay > 0 && recent24h >= 3) {
    burstSurprise = poissonSurprise(recent24h, expectedPerDay);
  }
  const burst = clamp((burstSurprise - 2) / 3);

  const intervals = (analysis.reviewer?.recentIntervalsSeconds ?? []).filter(
    (value) => Number.isFinite(value) && value >= 0,
  );
  const cv = coefficientOfVariation(intervals);
  const lowInterArrivalCv = intervals.length >= 5 ? clamp(1 - cv / 0.3) : 0;
  const minInterval = intervals.length > 0 ? Math.min(...intervals) : Number.POSITIVE_INFINITY;
  const impossibleIntervals = minInterval < 30 ? 1 : 0;

  const timestamps = (analysis.reviewer?.recentReviewTimestamps ?? [])
    .map((value) => new Date(value).getTime())
    .filter((value) => Number.isFinite(value));
  let syncCount = 0;
  for (const ts of timestamps) {
    if (Math.abs(ts - submittedMs) <= 10 * MINUTE_MS) syncCount += 1;
  }
  const sync = clamp((syncCount - 2) / 3);

  const hour = localHour(review.submittedAt, item?.localTimezone);
  const hourOfDay = hour ?? submitted.getUTCHours();
  const isWeekend = [0, 6].includes(submitted.getUTCDay());
  const oddHour = hourOfDay >= 2 && hourOfDay <= 5 ? 1 : 0;

  const accountAgeHours =
    analysis.reviewer?.accountCreatedAt &&
    Number.isFinite(new Date(analysis.reviewer.accountCreatedAt).getTime())
      ? (submittedMs - new Date(analysis.reviewer.accountCreatedAt).getTime()) / HOUR_MS
      : null;
  const reviewWithinHourOfSignup =
    accountAgeHours !== null && accountAgeHours >= 0 && accountAgeHours <= 1 ? 1 : 0;

  return {
    'temp.burstSurprise': burstSurprise,
    'temp.burst': burst,
    'temp.reviewsLast24h': recent24h,
    'temp.interArrivalCv': clamp(cv),
    'temp.lowInterArrivalCv': lowInterArrivalCv,
    'temp.minIntervalSeconds': Number.isFinite(minInterval) ? minInterval : 0,
    'temp.impossibleIntervals': impossibleIntervals,
    'temp.syncCount': syncCount,
    'temp.sync': sync,
    'temp.hourOfDay': hourOfDay,
    'temp.isWeekend': isWeekend ? 1 : 0,
    'temp.oddHour': oddHour,
    'temp.reviewWithinHourOfSignup': reviewWithinHourOfSignup,
    'temp.ageHours': accountAgeHours ?? 0,
    'temp.hasBurstBaseline': expectedPerDay !== undefined && expectedPerDay > 0 ? 1 : 0,
    'temp.hasIntervals': intervals.length >= 5 ? 1 : 0,
    'temp.submittedAgeDays': Number.isFinite(submittedMs)
      ? clamp((Date.now() - submittedMs) / DAY_MS / 3650)
      : 0,
  };
}
