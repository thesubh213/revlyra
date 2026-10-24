import type { Detector, DetectorContext, Signal } from '../types';
import { isEnabled, signal } from './helpers';

function run(ctx: DetectorContext): Signal[] {
  if (!isEnabled('rating', ctx.policy, 'rating')) return [];
  const features = ctx.features;
  const n = features['rating.sampleSize'] ?? 0;
  // Distribution metrics are too noisy below 30 reviews; do not emit a signal
  // that could be mistaken for evidence.
  if (n < 30) return [];

  const confidence = n >= 100 ? 0.85 : 0.6;
  const signals: Signal[] = [];

  const excess = features['rating.excessFiveStar'] ?? 0;
  if (excess >= 0.12) {
    signals.push(
      signal(
        'RATING_EXCESS_FIVESTAR',
        'rating',
        Math.min(0.65, excess * 1.8),
        confidence,
        'The item has more five-star ratings than its category baseline predicts.',
        { excess: Number(excess.toFixed(3)), sampleSize: n },
      ),
    );
  }

  const chiSeverity = features['rating.chiSeverity'] ?? 0;
  if (chiSeverity > 0) {
    signals.push(
      signal(
        'RATING_DISTRIBUTION_ANOMALY',
        'rating',
        Math.min(0.6, chiSeverity * 0.6),
        confidence,
        'The rating distribution differs significantly from the baseline distribution.',
        {
          chiSquare: Number((features['rating.chiSquare'] ?? 0).toFixed(2)),
          sampleSize: n,
        },
      ),
    );
  }

  const bimodality = features['rating.bimodality'] ?? 0;
  if (bimodality >= 0.6) {
    signals.push(
      signal(
        'RATING_BIMODAL',
        'rating',
        Math.min(0.5, (bimodality - 0.5) * 1.1),
        confidence,
        'Ratings are polarized into separate high and low clusters.',
        { bimodality: Number(bimodality.toFixed(3)), sampleSize: n },
      ),
    );
  }

  const meanShift = features['rating.meanShift'] ?? 0;
  if (meanShift >= 0.5) {
    signals.push(
      signal(
        'RATING_MEAN_SHIFT',
        'rating',
        Math.min(0.55, meanShift * 0.5),
        confidence,
        'The item’s recent average rating has shifted away from its baseline.',
        { meanShift: Number(meanShift.toFixed(3)), sampleSize: n },
      ),
    );
  }

  return signals;
}

export const ratingDetector: Detector = {
  id: 'rating',
  version: '1.0.0',
  families: ['rating'],
  run,
};
