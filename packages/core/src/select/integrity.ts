import { GENERIC_BASELINE } from '../codes';
import { computeBimodality } from '../features/rating';
import type { DistributionSignals, IntegrityInputReview, IntegrityResult } from '../types';

const DAY_MS = 86_400_000;

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

function decisionWeight(decision: IntegrityInputReview['decision']): number {
  switch (decision) {
    case 'allow':
      return 1;
    case 'label':
      return 0.8;
    case 'downrank':
      return 0.25;
    case 'hold':
    case 'remove':
    case 'escalate':
      return 0;
    default:
      return 0;
  }
}

function normalizeBaseline(
  baseline: number[] | Record<string, number> | undefined,
): number[] | null {
  if (!baseline) return null;
  const values = Array.isArray(baseline)
    ? baseline
    : ['1', '2', '3', '4', '5'].map((key) => baseline[key] ?? 0);
  if (values.length !== 5) return null;
  const total = values.reduce((sum, value) => sum + Math.max(0, value), 0);
  if (total <= 0) return null;
  return values.map((value) => Math.max(0, value) / total);
}

function distributionRecord(counts: number[]): Record<'1' | '2' | '3' | '4' | '5', number> {
  return {
    '1': counts[0] ?? 0,
    '2': counts[1] ?? 0,
    '3': counts[2] ?? 0,
    '4': counts[3] ?? 0,
    '5': counts[4] ?? 0,
  };
}

function distributionProportions(record: Record<'1' | '2' | '3' | '4' | '5', number>): number[] {
  const values = [record['1'], record['2'], record['3'], record['4'], record['5']];
  const total = values.reduce((sum, value) => sum + value, 0);
  return total > 0 ? values.map((value) => value / total) : [0, 0, 0, 0, 0];
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function computeIntegrity(
  reviews: IntegrityInputReview[],
  options: {
    priorMean?: number;
    priorWeight?: number;
    baselineDistribution?: number[] | Record<string, number>;
    /** Trust-weight for ratings: weight decays by exp(-ageDays / halfLife);
     * 0 disables decay. Default aligns with documented recency pressure
     * (74% of consumers disregard reviews older than ~3 months). */
    recencyHalfLifeDays?: number;
    /** Trust multiplier for verified-purchase reviews. */
    verifiedBoost?: number;
    /** Trust multiplier for explicitly unverified reviews. */
    unverifiedFactor?: number;
    now?: string;
  } = {},
): IntegrityResult {
  const priorMean = options.priorMean ?? 4.2;
  const priorWeight = options.priorWeight ?? 10;
  const baseline = normalizeBaseline(options.baselineDistribution) ?? GENERIC_BASELINE;
  const recencyHalfLifeDays = options.recencyHalfLifeDays ?? 120;
  const verifiedBoost = options.verifiedBoost ?? 1.15;
  const unverifiedFactor = options.unverifiedFactor ?? 0.9;
  const now = options.now ? new Date(options.now).getTime() : Date.now();

  const ageDays = (review: IntegrityInputReview, fallback: number | null): number => {
    if (!review.submittedAt) return fallback === null ? 0 : fallback;
    const value = new Date(review.submittedAt).getTime();
    return Number.isFinite(value)
      ? Math.max(0, (now - value) / DAY_MS)
      : fallback === null
        ? 0
        : fallback;
  };

  const counts = [0, 0, 0, 0, 0];
  let rawSum = 0;
  for (const review of reviews) {
    const bucket = Math.round(clamp(review.rating, 1, 5)) - 1;
    counts[bucket] = (counts[bucket] ?? 0) + 1;
    rawSum += review.rating;
  }

  const reviewCount = reviews.length;
  const rawRating = reviewCount > 0 ? rawSum / reviewCount : 0;

  const trustWeight = (review: IntegrityInputReview): number => {
    const base = clamp(review.trustScore) * decisionWeight(review.decision);
    if (base <= 0) return 0;
    let factor = 1;
    if (review.verifiedPurchase === true) factor *= verifiedBoost;
    else if (review.verifiedPurchase === false) factor *= unverifiedFactor;
    if (recencyHalfLifeDays > 0 && review.submittedAt) {
      factor *= Math.exp(-ageDays(review, null) / recencyHalfLifeDays);
    }
    return base * factor;
  };

  let weightSum = 0;
  let weightedRatingSum = 0;
  let weightedSquaredDeviation = 0;
  let weightSquaredSum = 0;
  let includedCount = 0;
  let verifiedKnown = 0;
  let verifiedCount = 0;
  let recentWeight90d = 0;
  for (const review of reviews) {
    const weight = trustWeight(review);
    if (review.verifiedPurchase !== undefined) {
      verifiedKnown += 1;
      if (review.verifiedPurchase) verifiedCount += 1;
    }
    if (weight <= 0) continue;
    includedCount += 1;
    weightSum += weight;
    weightSquaredSum += weight * weight;
    weightedRatingSum += weight * review.rating;
    if (review.submittedAt && ageDays(review, null) <= 90) recentWeight90d += weight;
  }

  const adjustedRating = (priorWeight * priorMean + weightedRatingSum) / (priorWeight + weightSum);

  for (const review of reviews) {
    const weight = trustWeight(review);
    if (weight <= 0) continue;
    weightedSquaredDeviation += weight * (review.rating - adjustedRating) ** 2;
  }

  const variance = weightSum > 0 ? weightedSquaredDeviation / weightSum : 1;
  const effectiveSampleSize = weightSum > 0 ? (weightSum * weightSum) / weightSquaredSum : 0;
  const standardError = effectiveSampleSize > 0 ? Math.sqrt(variance / effectiveSampleSize) : 0;
  const confidenceLow = clamp(adjustedRating - 1.96 * standardError, 1, 5);
  const confidenceHigh = clamp(adjustedRating + 1.96 * standardError, 1, 5);

  const flagged = reviews.filter(
    (review) =>
      review.decision === 'hold' || review.decision === 'remove' || review.decision === 'escalate',
  ).length;
  const suspicionRate = reviewCount > 0 ? flagged / reviewCount : 0;

  const observed = distributionProportions(distributionRecord(counts));
  const excessFiveStar = clamp((observed[4] ?? 0) - (baseline[4] ?? 0), 0, 1);
  const bimodality = computeBimodality(observed);

  let chiSquare: number | null = null;
  if (reviewCount >= 30) {
    chiSquare = observed.reduce((sum, value, index) => {
      const expected = baseline[index] ?? 0;
      if (expected <= 0) return sum;
      return sum + ((value - expected) ** 2 / expected) * reviewCount;
    }, 0);
  }

  const weightedStdDev = weightSum > 0 ? Math.sqrt(variance) : 0;
  const modeBucket = counts.reduce(
    (best, count, index) => (count > (counts[best] ?? 0) ? index : best),
    -1,
  );
  const ages = reviews
    .filter((review) => review.submittedAt)
    .map((review) => ageDays(review, null));
  const distributionSignals: DistributionSignals = {
    stdDev: Number(weightedStdDev.toFixed(3)),
    modeStars: modeBucket >= 0 ? modeBucket + 1 : 0,
    positiveRatio: Number(clamp((observed[3] ?? 0) + (observed[4] ?? 0)).toFixed(3)),
    criticalShare: Number(
      clamp((observed[0] ?? 0) + (observed[1] ?? 0) + (observed[2] ?? 0)).toFixed(3),
    ),
    polarizationIndex: Number(
      clamp(
        (observed[4] ?? 0) +
          (observed[0] ?? 0) -
          Math.max(observed[1] ?? 0, observed[2] ?? 0, observed[3] ?? 0),
      ).toFixed(3),
    ),
    allPositiveSuspicion: reviewCount >= 20 && counts[0]! + counts[1]! + counts[2]! === 0,
    verifiedShare: verifiedKnown > 0 ? Number((verifiedCount / verifiedKnown).toFixed(3)) : 0,
    recencyWeightedShare90d:
      weightSum > 0 && recentWeight90d > 0
        ? Number(clamp(recentWeight90d / weightSum).toFixed(3))
        : 0,
    medianAgeDays: ages.length > 0 ? Number((median(ages) ?? 0).toFixed(1)) : null,
  };

  const concerns = new Map<string, number>();
  for (const review of reviews) {
    for (const code of review.concerns ?? []) {
      concerns.set(code, (concerns.get(code) ?? 0) + 1);
    }
  }
  const topConcerns = Array.from(concerns.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([code, count]) => `${code} (${count})`);

  return {
    rawRating: Number(rawRating.toFixed(3)),
    adjustedRating: Number(adjustedRating.toFixed(3)),
    delta: Number((adjustedRating - rawRating).toFixed(3)),
    confidenceLow: Number(confidenceLow.toFixed(3)),
    confidenceHigh: Number(confidenceHigh.toFixed(3)),
    effectiveSampleSize: Number(effectiveSampleSize.toFixed(2)),
    reviewCount,
    includedCount,
    suspicionRate: Number(suspicionRate.toFixed(3)),
    excessFiveStar: Number(excessFiveStar.toFixed(3)),
    chiSquare: chiSquare === null ? null : Number(chiSquare.toFixed(2)),
    distribution: distributionRecord(counts),
    baselineDistribution: {
      '1': Number((baseline[0] ?? 0).toFixed(4)),
      '2': Number((baseline[1] ?? 0).toFixed(4)),
      '3': Number((baseline[2] ?? 0).toFixed(4)),
      '4': Number((baseline[3] ?? 0).toFixed(4)),
      '5': Number((baseline[4] ?? 0).toFixed(4)),
    },
    bimodality: Number(bimodality.toFixed(3)),
    distributionSignals,
    topConcerns,
  };
}
