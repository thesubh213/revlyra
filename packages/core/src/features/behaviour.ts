import type { AnalysisContext, CanonicalReview, FeatureSet, ReviewerProfile } from '../types';
import { clamp } from './content';

const DAY_MS = 86_400_000;

function distributionEntropy(distribution?: number[]): number {
  if (distribution?.length !== 5) return 0;
  const total = distribution.reduce((sum, value) => sum + value, 0);
  if (total === 0) return 0;
  let entropy = 0;
  for (const count of distribution) {
    if (count <= 0) continue;
    const p = count / total;
    entropy -= p * Math.log2(p);
  }
  return clamp(entropy / Math.log2(5));
}

function fiveStarRatio(reviewer?: ReviewerProfile): number {
  if (!reviewer) return 0;
  if (reviewer.fiveStarRatio !== undefined) return clamp(reviewer.fiveStarRatio);
  if (reviewer.ratingDistribution && reviewer.ratingDistribution.length === 5) {
    const total = reviewer.ratingDistribution.reduce((sum, value) => sum + value, 0);
    return total > 0 ? clamp((reviewer.ratingDistribution[4] ?? 0) / total) : 0;
  }
  return 0;
}

export function extractBehaviourFeatures(
  review: CanonicalReview,
  analysis: AnalysisContext,
): FeatureSet {
  const reviewer = analysis.reviewer;
  const now = new Date(analysis.now ?? new Date().toISOString());
  const submitted = new Date(review.submittedAt);
  const created = reviewer?.accountCreatedAt ? new Date(reviewer.accountCreatedAt) : null;
  const accountAgeDays =
    created && Number.isFinite(created.getTime())
      ? Math.max(0, (submitted.getTime() - created.getTime()) / DAY_MS)
      : null;

  const reviews24h = reviewer?.reviewsLast24h ?? 0;
  const reviews7d = reviewer?.reviewsLast7d ?? 0;
  const reviews30d = reviewer?.reviewsLast30d ?? 0;

  const peerMedianPerDay = analysis.peer?.medianReviewsPerDay ?? 0.5;
  const velocityRatio = (reviews24h + 1) / (peerMedianPerDay + 1);
  const velocity = clamp(
    Math.max(reviews24h / 5, reviews7d / 20, reviews30d / 60, Math.log10(velocityRatio + 1) / 1.5),
  );

  const itemAverage = analysis.item?.averageRating;
  const itemCount = analysis.item?.totalReviews ?? 0;
  const ratingDeviation =
    itemAverage !== undefined && itemCount >= 5
      ? clamp(Math.abs(review.rating - itemAverage) / 2)
      : 0;

  const entropy =
    reviewer?.ratingEntropy !== undefined
      ? clamp(reviewer.ratingEntropy / Math.log2(5))
      : distributionEntropy(reviewer?.ratingDistribution);
  const lowEntropy = reviewer?.ratingDistribution
    ? clamp(1 - entropy)
    : reviewer?.ratingEntropy !== undefined
      ? clamp(1 - reviewer.ratingEntropy / Math.log2(5))
      : 0;

  const priorFlags = clamp((reviewer?.priorFlags ?? 0) / 3);
  const unverified = review.verifiedPurchase === false ? 1 : 0;
  const newAccount = accountAgeDays !== null && accountAgeDays < 7 ? 1 : 0;
  const categoryHopping = clamp((reviewer?.categoryEntropy ?? 0) / 3);

  return {
    'beh.historyAvailable': reviewer ? 1 : 0,
    'beh.accountAgeDays': accountAgeDays ?? 365,
    'beh.accountAgeKnown': accountAgeDays === null ? 0 : 1,
    'beh.newAccount': newAccount,
    'beh.reviewCount': reviewer?.totalReviews ?? 0,
    'beh.reviewsLast24h': reviews24h,
    'beh.reviewsLast7d': reviews7d,
    'beh.reviewsLast30d': reviews30d,
    'beh.velocity': velocity,
    'beh.velocityRatio': clamp(Math.log10(velocityRatio + 1) / 1.5),
    'beh.ratingDeviation': ratingDeviation,
    'beh.ratingEntropy': entropy,
    'beh.lowEntropy': lowEntropy,
    'beh.fiveStarRatio': fiveStarRatio(reviewer),
    'beh.priorFlags': priorFlags,
    'beh.unverified': unverified,
    'beh.categoryHopping': categoryHopping,
    'beh.sharedDeviceCount': clamp((reviewer?.sharedDeviceCount ?? 0) / 5),
    'beh.sharedSubnetCount': clamp((reviewer?.sharedSubnetCount ?? 0) / 20),
    'beh.appealsOverturned': clamp((reviewer?.priorAppealsOverturned ?? 0) / 3),
    'beh.daysSinceLastReview': reviewer?.lastReviewAt
      ? clamp((now.getTime() - new Date(reviewer.lastReviewAt).getTime()) / DAY_MS / 365)
      : 1,
  };
}
