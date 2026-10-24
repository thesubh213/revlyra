import { SIGNAL_FAMILIES } from '../detectors';
import { calibrate, logit, scoreModel, sigmoid } from '../model';
import type {
  AnalysisContext,
  CanonicalReview,
  FamilyScore,
  FeatureSet,
  ModelArtifact,
  Policy,
  Signal,
  SignalFamily,
} from '../types';

export interface FusionOutput {
  score: number;
  confidence: number;
  dataCompleteness: number;
  modelScore: number;
  familyDetails: Record<SignalFamily, FamilyScore>;
  familyScores: Record<SignalFamily, number>;
}

function emptyFamilyDetails(): Record<SignalFamily, FamilyScore> {
  const details = {} as Record<SignalFamily, FamilyScore>;
  for (const family of SIGNAL_FAMILIES) {
    details[family] = { score: 0, rawMax: 0, count: 0, hard: false };
  }
  return details;
}

export function aggregateFamilies(signals: Signal[]): Record<SignalFamily, FamilyScore> {
  const details = emptyFamilyDetails();
  for (const item of signals) {
    const bucket = details[item.family];
    bucket.count += 1;
    bucket.rawMax = Math.max(bucket.rawMax, item.severity * item.confidence);
    bucket.hard = bucket.hard || item.hard === true;
  }
  for (const family of SIGNAL_FAMILIES) {
    const bucket = details[family];
    const corroboration = Math.max(0, bucket.count - 1);
    bucket.score = Math.min(1, bucket.rawMax + 0.15 * Math.min(1, corroboration / 3));
  }
  return details;
}

export function computeDataCompleteness(
  review: CanonicalReview,
  analysis: AnalysisContext,
): number {
  const text = review.text.trim().length > 0 ? 1 : 0;
  const reviewer = analysis.reviewer ? 1 : 0;
  const item = analysis.item ? 1 : 0;
  const corpus = analysis.corpus && analysis.corpus.totalReviews >= 50 ? 1 : 0;
  const hasContext =
    review.context &&
    Object.values(review.context).some((value) => value !== undefined && value !== null)
      ? 1
      : 0;
  const hasMedia = (review.media?.length ?? 0) > 0;
  const mediaAnalyzed = hasMedia
    ? review.media?.every((itemMedia) => itemMedia.sha256 || itemMedia.phash || itemMedia.exif)
      ? 1
      : 0
    : 1;
  const graph = analysis.campaign ? 1 : 0.5;

  return (
    text * 0.3 +
    reviewer * 0.2 +
    item * 0.15 +
    corpus * 0.15 +
    hasContext * 0.1 +
    mediaAnalyzed * 0.05 +
    graph * 0.05
  );
}

export function computeConfidence(
  signals: Signal[],
  dataCompleteness: number,
  model: ModelArtifact,
  analysis: AnalysisContext,
): number {
  if (signals.length === 0) return Math.min(0.35, 0.15 + dataCompleteness * 0.2);
  const top = signals.slice(0, 5);
  const averageSignalConfidence = top.reduce((sum, item) => sum + item.confidence, 0) / top.length;
  const families = new Set(signals.map((item) => item.family)).size;
  const modelQuality =
    model.metrics?.calibrationStatus !== undefined
      ? Math.min(1, Math.max(0, model.metrics.calibrationStatus))
      : 0.5;
  let confidence =
    0.35 * dataCompleteness +
    0.45 * averageSignalConfidence +
    0.1 * Math.min(1, families / 3) +
    0.1 * modelQuality;
  if ((analysis.corpus?.totalReviews ?? 0) < 50) confidence -= 0.05;
  if (!analysis.reviewer) confidence -= 0.05;
  return Math.min(0.99, Math.max(0.05, confidence));
}

export function fuse(
  signals: Signal[],
  features: FeatureSet,
  policy: Policy,
  model: ModelArtifact,
  review: CanonicalReview,
  analysis: AnalysisContext,
): FusionOutput {
  const familyDetails = aggregateFamilies(signals);
  const familyScores = {} as Record<SignalFamily, number>;
  let value = policy.intercept;

  for (const family of SIGNAL_FAMILIES) {
    const score = policy.disabledFamilies.includes(family) ? 0 : familyDetails[family].score;
    familyScores[family] = score;
    value += policy.familyWeights[family] * score;
  }

  const rawModelScore = scoreModel(features, model);
  const modelScore = calibrate(rawModelScore, model);
  value += policy.modelWeight * logit(modelScore);

  let score = sigmoid(value);
  const hasHardFlag = signals.some((item) => item.hard === true);
  if (hasHardFlag) score = Math.max(score, policy.hardFlagFloor);
  score = Math.min(0.999, Math.max(0, score));

  const dataCompleteness = computeDataCompleteness(review, analysis);
  const confidence = computeConfidence(signals, dataCompleteness, model, analysis);

  return { score, confidence, dataCompleteness, modelScore, familyDetails, familyScores };
}
