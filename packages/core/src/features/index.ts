import type { AnalysisContext, CanonicalReview, FeatureSet, NormalizedReview } from '../types';
import { extractBehaviourFeatures } from './behaviour';
import { extractContentFeatures } from './content';
import { extractMediaFeatures } from './media';
import { extractNetworkFeatures } from './network';
import { extractRatingFeatures } from './rating';
import { extractTemporalFeatures } from './temporal';

export function extractFeatures(
  review: CanonicalReview,
  normalized: NormalizedReview,
  analysis: AnalysisContext,
): FeatureSet {
  return {
    ...extractContentFeatures(review, normalized, analysis),
    ...extractBehaviourFeatures(review, analysis),
    ...extractTemporalFeatures(review, analysis),
    ...extractNetworkFeatures(review, analysis),
    ...extractMediaFeatures(review, analysis),
    ...extractRatingFeatures(analysis.item),
    'meta.languageEn': normalized.language === 'en' ? 1 : 0,
    'meta.languageConfidence': normalized.languageConfidence,
    'meta.textLength': normalized.text.length,
    'meta.hasMedia': (review.media?.length ?? 0) > 0 ? 1 : 0,
    'meta.hasReviewerProfile': analysis.reviewer ? 1 : 0,
    'meta.hasItemProfile': analysis.item ? 1 : 0,
    'meta.hasCorpus': analysis.corpus && analysis.corpus.totalReviews >= 50 ? 1 : 0,
  };
}

export * from './behaviour';
export * from './content';
export * from './lexicons';
export * from './media';
export * from './network';
export * from './rating';
export * from './temporal';
