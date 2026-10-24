import { GENERIC_BASELINE } from '../codes';
import type { FeatureSet, ItemProfile } from '../types';
import { clamp } from './content';

function normalize(counts: number[] | undefined): number[] {
  if (counts?.length !== 5) return [];
  const total = counts.reduce((sum, value) => sum + Math.max(0, value), 0);
  if (total <= 0) return [];
  return counts.map((value) => Math.max(0, value) / total);
}

function skewness(values: number[], mean: number, stdDev: number): number {
  if (stdDev === 0 || values.length < 3) return 0;
  const n = values.length;
  const sum = values.reduce((acc, value) => acc + ((value - mean) / stdDev) ** 3, 0);
  return (n / ((n - 1) * (n - 2))) * sum;
}

function kurtosis(values: number[], mean: number, stdDev: number): number {
  if (stdDev === 0 || values.length < 4) return 0;
  const n = values.length;
  const sum = values.reduce((acc, value) => acc + ((value - mean) / stdDev) ** 4, 0);
  return (
    ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * sum - (3 * (n - 1) ** 2) / ((n - 2) * (n - 3))
  );
}

function expandDistribution(proportions: number[]): number[] {
  const values: number[] = [];
  for (let i = 0; i < proportions.length; i += 1) {
    const count = Math.round((proportions[i] ?? 0) * 1000);
    for (let j = 0; j < count; j += 1) values.push(i + 1);
  }
  return values;
}

function distributionMoments(values: number[]): { mean: number; stdDev: number } {
  if (values.length === 0) return { mean: 0, stdDev: 0 };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return { mean, stdDev: Math.sqrt(variance) };
}

export function computeBimodality(proportions: number[]): number {
  const values = expandDistribution(proportions);
  if (values.length < 4) return 0;
  const { mean, stdDev } = distributionMoments(values);
  if (stdDev === 0) return 0;
  const n = values.length;
  const skew = skewness(values, mean, stdDev);
  const kurt = kurtosis(values, mean, stdDev);
  const denominator = kurt + (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
  if (!Number.isFinite(denominator) || denominator === 0) return 0;
  return clamp((skew * skew + 1) / denominator, 0, 1.5);
}

export function extractRatingFeatures(item?: ItemProfile): FeatureSet {
  const counts = item?.ratingDistribution;
  const n = counts ? counts.reduce((sum, value) => sum + value, 0) : 0;
  if (counts?.length !== 5 || n === 0) {
    return {
      'rating.sampleSize': 0,
      'rating.excessFiveStar': 0,
      'rating.chiSquare': 0,
      'rating.chiSeverity': 0,
      'rating.bimodality': 0,
      'rating.meanShift': 0,
      'rating.distributionAnomaly': 0,
    };
  }

  const observed = counts.map((value) => value / n);
  const normalizedBaseline = normalize(item?.baselineDistribution);
  const baseline = normalizedBaseline.length === 5 ? normalizedBaseline : GENERIC_BASELINE;

  const chiSquare =
    observed.reduce((sum, value, index) => {
      const expected = baseline[index] ?? 0.0;
      if (expected <= 0) return sum;
      return sum + (value - expected) ** 2 / expected;
    }, 0) * n;

  const chiSeverity =
    chiSquare >= 13.28 ? 1 : chiSquare >= 9.49 ? 0.7 : chiSquare >= 7.78 ? 0.4 : 0;

  const excessFiveStar = clamp((observed[4] ?? 0) - (baseline[4] ?? 0), 0, 1);
  const bimodality = computeBimodality(observed);

  const mean = observed.reduce((sum, value, index) => sum + value * (index + 1), 0);
  const variance = observed.reduce((sum, value, index) => sum + value * (index + 1 - mean) ** 2, 0);
  const stdDev = Math.sqrt(variance);
  const baselineMean =
    item?.baselineMean ?? baseline.reduce((sum, value, index) => sum + value * (index + 1), 0);
  const standardError = stdDev / Math.sqrt(Math.max(1, n));
  const meanShift =
    standardError > 0 ? clamp(Math.abs(mean - baselineMean) / (standardError * 2)) : 0;

  const anomaly = clamp(
    Math.max(chiSeverity * 0.9, excessFiveStar / 0.25, (bimodality - 0.55) / 0.4, meanShift * 0.8),
  );

  return {
    'rating.sampleSize': n,
    'rating.observedMean': mean,
    'rating.baselineMean': baselineMean,
    'rating.excessFiveStar': excessFiveStar,
    'rating.chiSquare': chiSquare,
    'rating.chiSeverity': chiSeverity,
    'rating.bimodality': bimodality,
    'rating.meanShift': meanShift,
    'rating.distributionAnomaly': anomaly,
  };
}
