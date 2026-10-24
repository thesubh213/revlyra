import type { Detector, DetectorContext, Signal } from '../types';
import { isEnabled, signal } from './helpers';

function run(ctx: DetectorContext): Signal[] {
  if (!isEnabled('temporal', ctx.policy, 'temporal')) return [];
  const features = ctx.features;
  const signals: Signal[] = [];
  const hasBaseline = (features['temp.hasBurstBaseline'] ?? 0) > 0;
  const burst = features['temp.burst'] ?? 0;

  if (burst >= 0.25 && hasBaseline) {
    signals.push(
      signal(
        'TIME_PRODUCT_BURST',
        'temporal',
        Math.min(0.85, 0.3 + burst * 0.55),
        0.7,
        'The item received an unusual burst of reviews relative to its baseline rate.',
        {
          reviewsLast24h: ctx.analysis.item?.recentReviews24h ?? 0,
          expectedPerDay: ctx.analysis.item?.expectedReviewsPerDay ?? null,
          surprise: Number((features['temp.burstSurprise'] ?? 0).toFixed(2)),
        },
      ),
    );
  }

  const lowCv = features['temp.lowInterArrivalCv'] ?? 0;
  if (lowCv >= 0.5) {
    signals.push(
      signal(
        'TIME_LOW_INTERARRIVAL_CV',
        'temporal',
        Math.min(0.7, 0.35 + lowCv * 0.35),
        0.7,
        'The reviewer posts at suspiciously regular intervals.',
        {
          intervals: ctx.analysis.reviewer?.recentIntervalsSeconds?.slice(0, 10) ?? [],
          cv: Number((features['temp.interArrivalCv'] ?? 0).toFixed(3)),
        },
      ),
    );
  }

  if ((features['temp.impossibleIntervals'] ?? 0) > 0) {
    signals.push(
      signal(
        'TIME_IMPOSSIBLE_INTERVALS',
        'temporal',
        0.7,
        0.8,
        'The reviewer posted multiple reviews within seconds of each other.',
        { minIntervalSeconds: features['temp.minIntervalSeconds'] ?? 0 },
      ),
    );
  }

  const sync = features['temp.sync'] ?? 0;
  if (sync >= 0.3) {
    signals.push(
      signal(
        'TIME_SYNC_POSTING',
        'temporal',
        Math.min(0.65, 0.3 + sync * 0.35),
        0.6,
        'Several reviews were posted in a tight time window.',
        { reviewsWithin10Minutes: features['temp.syncCount'] ?? 0 },
      ),
    );
  }

  if ((features['temp.reviewWithinHourOfSignup'] ?? 0) > 0) {
    signals.push(
      signal(
        'TIME_REVIEW_AFTER_SIGNUP',
        'temporal',
        0.3,
        0.6,
        'The review was posted within an hour of account creation.',
        { accountAgeHours: Number((features['temp.ageHours'] ?? 0).toFixed(2)) },
      ),
    );
  }

  return signals;
}

export const temporalDetector: Detector = {
  id: 'temporal',
  version: '1.0.0',
  families: ['temporal'],
  run,
};
