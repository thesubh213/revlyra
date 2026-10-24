import {
  type AnalysisContext,
  type CanonicalReview,
  type MediaMatch,
  minhashBandKeys,
  minhashSignature,
  type NormalizedReview,
  normalizeReview,
  type ReviewerProfile,
  shingles,
  simhashBandKeys,
  type TextMatch,
} from '@revlyra/core';
import type { RevlyraConfig } from '../config';
import type { Store } from '../store';
import type { ReviewRecord } from '../store/types';

export interface PreparedContext {
  analysis: AnalysisContext;
  normalized: NormalizedReview;
  canonical: CanonicalReview;
}

export function canonicalFromRecord(record: ReviewRecord): CanonicalReview {
  return {
    id: record.id,
    tenantId: record.tenantId,
    itemId: record.itemId,
    reviewerId: record.reviewerId,
    rating: record.rating,
    text: record.text,
    language: record.language,
    submittedAt: record.submittedAt,
    verifiedPurchase: record.context.verifiedKnown === false ? undefined : record.verified,
    context: record.context as CanonicalReview['context'],
    media: record.media as CanonicalReview['media'],
  };
}

function statsNumber(stats: Record<string, unknown>, key: string): number | undefined {
  const value = stats[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function statsString(stats: Record<string, unknown>, key: string): string | undefined {
  const value = stats[key];
  return typeof value === 'string' ? value : undefined;
}

function statsArray(stats: Record<string, unknown>, key: string): number[] | undefined {
  const value = stats[key];
  return Array.isArray(value) && value.every((item) => typeof item === 'number')
    ? (value as number[])
    : undefined;
}

export async function prepareAnalysisContext(
  store: Store,
  config: RevlyraConfig,
  record: ReviewRecord,
): Promise<PreparedContext> {
  const canonical = canonicalFromRecord(record);
  const normalized = normalizeReview(canonical);

  const [reviewerRecord, itemRecord, reviewerAgg, itemAgg, corpus, campaign] = await Promise.all([
    store.getReviewerById(record.tenantId, record.reviewerId),
    store.getItemById(record.tenantId, record.itemId),
    store.getReviewerAggregates(record.tenantId, record.reviewerId),
    store.getItemAggregates(record.tenantId, record.itemId),
    store.getCorpusStats(record.tenantId),
    store.getCampaignForReviewer(record.tenantId, record.reviewerId),
  ]);

  const reviewerStats = reviewerRecord?.stats ?? {};
  const itemStats = itemRecord?.stats ?? {};

  const reviewer: ReviewerProfile = {
    id: reviewerRecord?.id ?? record.reviewerId,
    ...(reviewerRecord?.accountCreatedAt
      ? { accountCreatedAt: reviewerRecord.accountCreatedAt }
      : {}),
    totalReviews: reviewerAgg.totalReviews,
    reviewsLast24h: reviewerAgg.reviewsLast24h,
    reviewsLast7d: reviewerAgg.reviewsLast7d,
    reviewsLast30d: reviewerAgg.reviewsLast30d,
    ...(reviewerAgg.averageRating !== null ? { averageRating: reviewerAgg.averageRating } : {}),
    ...(reviewerAgg.ratingStdDev !== null ? { ratingStdDev: reviewerAgg.ratingStdDev } : {}),
    ratingDistribution: reviewerAgg.ratingDistribution,
    ...(reviewerAgg.fiveStarRatio !== null ? { fiveStarRatio: reviewerAgg.fiveStarRatio } : {}),
    ...(statsNumber(reviewerStats, 'verifiedPurchaseRatio') !== undefined
      ? { verifiedPurchaseRatio: statsNumber(reviewerStats, 'verifiedPurchaseRatio') }
      : {}),
    ...(statsNumber(reviewerStats, 'categoryEntropy') !== undefined
      ? { categoryEntropy: statsNumber(reviewerStats, 'categoryEntropy') }
      : {}),
    ...(reviewerAgg.firstReviewAt ? { firstReviewAt: reviewerAgg.firstReviewAt } : {}),
    ...(reviewerAgg.lastReviewAt ? { lastReviewAt: reviewerAgg.lastReviewAt } : {}),
    sharedDeviceCount: statsNumber(reviewerStats, 'sharedDeviceCount') ?? 0,
    sharedSubnetCount: statsNumber(reviewerStats, 'sharedSubnetCount') ?? 0,
    priorFlags: statsNumber(reviewerStats, 'priorFlags') ?? 0,
    priorAppealsOverturned: statsNumber(reviewerStats, 'priorAppealsOverturned') ?? 0,
    recentIntervalsSeconds: reviewerAgg.recentIntervalsSeconds,
    recentReviewTimestamps: reviewerAgg.recentTimestamps,
    ...(statsString(reviewerStats, 'timezone')
      ? { timezone: statsString(reviewerStats, 'timezone') }
      : {}),
    ...(statsString(reviewerStats, 'locale')
      ? { locale: statsString(reviewerStats, 'locale') }
      : {}),
  };

  const baselineDistribution =
    statsArray(itemStats, 'baselineDistribution') ??
    (Array.isArray(itemRecord?.attributes?.baselineDistribution)
      ? (itemRecord!.attributes.baselineDistribution as number[])
      : undefined);

  const item = {
    id: itemRecord?.id ?? record.itemId,
    ...(itemRecord?.category ? { category: itemRecord.category } : {}),
    totalReviews: itemAgg.totalReviews,
    ...(itemAgg.averageRating !== null ? { averageRating: itemAgg.averageRating } : {}),
    ...(itemAgg.ratingStdDev !== null ? { ratingStdDev: itemAgg.ratingStdDev } : {}),
    ratingDistribution: itemAgg.ratingDistribution,
    recentReviews24h: itemAgg.recentReviews24h,
    recentReviews7d: itemAgg.recentReviews7d,
    ...(statsNumber(itemStats, 'expectedReviewsPerDay') !== undefined
      ? { expectedReviewsPerDay: statsNumber(itemStats, 'expectedReviewsPerDay') }
      : {}),
    ...(statsNumber(itemStats, 'baselineMean') !== undefined
      ? { baselineMean: statsNumber(itemStats, 'baselineMean') }
      : {}),
    ...(baselineDistribution ? { baselineDistribution } : {}),
    ...(statsString(itemStats, 'localTimezone')
      ? { localTimezone: statsString(itemStats, 'localTimezone') }
      : {}),
    attributes: itemRecord?.attributes ?? {},
  };

  const simBands = simhashBandKeys(normalized.simhash, 4, 16);
  const minhashBands = minhashBandKeys(minhashSignature(shingles(normalized.tokens, 5)), 16);
  const textMatchesRaw = await store.findTextMatches(record.tenantId, {
    textSha256: normalized.exactHash,
    simhash: normalized.simhash,
    simhashBands: simBands,
    minhashBands,
    excludeReviewId: record.id,
    limit: 20,
  });

  const textMatches: TextMatch[] = textMatchesRaw.map((match) => ({
    reviewId: match.reviewId,
    reviewerId: match.reviewerId,
    itemId: match.itemId,
    similarity: match.similarity,
    kind: match.kind,
    ...(match.submittedAt ? { submittedAt: match.submittedAt } : {}),
  }));

  const mediaMatchesMap = new Map<string, MediaMatch>();
  for (const media of record.media as Array<Record<string, unknown>>) {
    const sha256 = typeof media.sha256 === 'string' ? media.sha256 : null;
    const phash = typeof media.phash === 'string' ? media.phash : null;
    if (!sha256 && !phash) continue;
    const matches = await store.findMediaMatches(record.tenantId, {
      sha256,
      phash,
      phashBands: phash ? simhashBandKeys(phash, 4, 16) : [],
      excludeReviewId: record.id,
      limit: 20,
    });
    for (const match of matches) {
      const existing = mediaMatchesMap.get(match.reviewId);
      if (
        !existing ||
        (match.kind === 'exact' && existing.kind !== 'exact') ||
        (match.kind === existing.kind && match.distance < existing.distance)
      ) {
        mediaMatchesMap.set(match.reviewId, {
          reviewId: match.reviewId,
          reviewerId: match.reviewerId,
          itemId: match.itemId,
          kind: match.kind,
          distance: match.distance,
        });
      }
    }
  }

  const campaignHint = campaign
    ? {
        id: campaign.id,
        score: campaign.score,
        memberCount: campaign.memberCount,
        signalFamilies: Array.isArray(campaign.evidence.signalFamilies)
          ? (campaign.evidence.signalFamilies as string[])
          : ['graph'],
      }
    : undefined;

  return {
    normalized,
    canonical,
    analysis: {
      reviewer,
      item,
      now: new Date().toISOString(),
      corpus: { totalReviews: corpus.totalReviews },
      textMatches,
      mediaMatches: Array.from(mediaMatchesMap.values()),
      ...(campaignHint ? { campaign: campaignHint } : {}),
      peer: { medianReviewsPerDay: 0.5 },
      metadata: { tenantId: record.tenantId, configPolicy: config.detection.policy },
    },
  };
}
