import type { Detector, DetectorContext, Signal } from '../types';
import { isEnabled, signal } from './helpers';

function run(ctx: DetectorContext): Signal[] {
  if (!isEnabled('reviewer-behaviour', ctx.policy, 'behaviour')) return [];
  const features = ctx.features;
  const reviewer = ctx.analysis.reviewer;
  const historyConfidence = reviewer
    ? Math.min(0.9, 0.45 + Math.min(0.4, (reviewer.totalReviews ?? 0) / 50))
    : 0.2;
  const signals: Signal[] = [];

  if ((features['beh.newAccount'] ?? 0) > 0 && (reviewer?.totalReviews ?? 0) <= 1) {
    signals.push(
      signal(
        'BEH_NEW_ACCOUNT',
        'behaviour',
        0.35,
        historyConfidence,
        'The reviewer account was created shortly before this review.',
        {
          accountAgeDays: Number((features['beh.accountAgeDays'] ?? 0).toFixed(1)),
          totalReviews: reviewer?.totalReviews ?? 0,
        },
      ),
    );
  }

  const velocity = features['beh.velocity'] ?? 0;
  if (velocity >= 0.3) {
    signals.push(
      signal(
        'BEH_HIGH_VELOCITY',
        'behaviour',
        Math.min(0.7, 0.3 + velocity * 0.45),
        historyConfidence,
        'The reviewer posts at an unusually high rate.',
        {
          last24h: reviewer?.reviewsLast24h ?? 0,
          last7d: reviewer?.reviewsLast7d ?? 0,
          last30d: reviewer?.reviewsLast30d ?? 0,
          velocity: Number(velocity.toFixed(3)),
        },
      ),
    );
  }

  const deviation = features['beh.ratingDeviation'] ?? 0;
  if (deviation >= 0.5) {
    signals.push(
      signal(
        'BEH_RATING_DEVIATION',
        'behaviour',
        Math.min(0.55, 0.2 + deviation * 0.4),
        0.55,
        'The rating deviates sharply from the item average.',
        {
          rating: ctx.review.rating,
          itemAverage: ctx.analysis.item?.averageRating,
          deviation: Number(deviation.toFixed(3)),
        },
      ),
    );
  }

  const lowEntropy = features['beh.lowEntropy'] ?? 0;
  if (lowEntropy >= 0.8 && (reviewer?.totalReviews ?? 0) >= 5) {
    signals.push(
      signal(
        'BEH_RATING_ENTROPY',
        'behaviour',
        0.55,
        historyConfidence,
        'The reviewer gives nearly the same rating to every item.',
        { lowEntropy: Number(lowEntropy.toFixed(3)), totalReviews: reviewer?.totalReviews ?? 0 },
      ),
    );
  }

  const fiveStar = features['beh.fiveStarRatio'] ?? 0;
  if (fiveStar >= 0.95 && (reviewer?.totalReviews ?? 0) >= 10) {
    signals.push(
      signal(
        'BEH_FIVESTAR_PATTERN',
        'behaviour',
        0.5,
        historyConfidence,
        'Almost all of the reviewer’s history is five-star ratings.',
        { fiveStarRatio: Number(fiveStar.toFixed(3)), totalReviews: reviewer?.totalReviews ?? 0 },
      ),
    );
  }

  const prior = features['beh.priorFlags'] ?? 0;
  const appealsOverturned = reviewer?.priorAppealsOverturned ?? 0;
  if (prior > 0 || appealsOverturned > 0) {
    signals.push(
      signal(
        'BEH_PRIOR_FLAGS',
        'behaviour',
        Math.min(0.8, 0.25 + prior * 0.5 + (features['beh.appealsOverturned'] ?? 0) * 0.15),
        0.75,
        'The reviewer has prior reviews flagged for manipulation or overturned appeals against those flags.',
        { priorFlags: reviewer?.priorFlags ?? 0, appealsOverturned },
      ),
    );
  }

  const categoryHopping = features['beh.categoryHopping'] ?? 0;
  if (categoryHopping >= 0.7 && velocity >= 0.35) {
    signals.push(
      signal(
        'BEH_CATEGORY_HOPPING',
        'behaviour',
        0.4,
        historyConfidence,
        'The reviewer moves rapidly across unrelated product categories.',
        { categoryEntropy: reviewer?.categoryEntropy ?? 0 },
      ),
    );
  }

  if ((features['beh.unverified'] ?? 0) > 0) {
    signals.push(
      signal(
        'BEH_UNVERIFIED',
        'behaviour',
        0.15,
        0.5,
        'The review is not tied to a verified purchase.',
        { verifiedPurchase: ctx.review.verifiedPurchase ?? null },
      ),
    );
  }

  return signals;
}

export const reviewerBehaviourDetector: Detector = {
  id: 'reviewer-behaviour',
  version: '1.0.0',
  families: ['behaviour'],
  run,
};
