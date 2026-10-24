import { runDetectors } from './detectors';
import { extractFeatures } from './features';
import { BASELINE_MODEL, resolveModel } from './model';
import { normalizeReview } from './normalize';
import { getPolicyPreset } from './policy/presets';
import { decide, riskBand } from './scoring/decision';
import { buildReasons } from './scoring/explain';
import { fuse } from './scoring/fusion';
import type {
  AnalysisContext,
  AnalysisOptions,
  AnalysisResult,
  CanonicalReview,
  DecisionKind,
  Policy,
} from './types';

const MAX_TEXT_LENGTH = 20_000;

const DECISION_ORDER: DecisionKind[] = ['allow', 'label', 'downrank', 'hold', 'escalate', 'remove'];

function decisionAtLeast(current: DecisionKind, floor: DecisionKind): DecisionKind {
  return DECISION_ORDER.indexOf(current) >= DECISION_ORDER.indexOf(floor) ? current : floor;
}

export class ReviewValidationError extends Error {
  readonly code = 'VALIDATION_ERROR';
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ReviewValidationError';
    this.details = details;
  }
}

function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function validatedReview(review: CanonicalReview): CanonicalReview {
  if (!review || typeof review !== 'object') {
    throw new ReviewValidationError('Review must be an object.');
  }
  for (const field of ['itemId', 'reviewerId'] as const) {
    if (typeof review[field] !== 'string' || review[field].trim().length === 0) {
      throw new ReviewValidationError(`Review.${field} is required.`, { field });
    }
  }
  if (typeof review.rating !== 'number' || !Number.isFinite(review.rating)) {
    throw new ReviewValidationError('Review.rating must be a number between 1 and 5.', {
      field: 'rating',
    });
  }
  if (review.rating < 1 || review.rating > 5) {
    throw new ReviewValidationError('Review.rating must be between 1 and 5.', {
      field: 'rating',
      value: review.rating,
    });
  }
  if (review.submittedAt === undefined || Number.isNaN(new Date(review.submittedAt).getTime())) {
    throw new ReviewValidationError('Review.submittedAt must be a valid ISO date.', {
      field: 'submittedAt',
    });
  }
  if (typeof review.text !== 'string') {
    throw new ReviewValidationError('Review.text must be a string.', { field: 'text' });
  }
  return {
    ...review,
    id: review.id || `${review.itemId}:${review.reviewerId}:${review.submittedAt}`,
    text: review.text.slice(0, MAX_TEXT_LENGTH),
    rating: Math.round(review.rating * 10) / 10,
  };
}

function resolvePolicy(policy: Policy | string | undefined): Policy {
  if (policy === undefined) return getPolicyPreset('balanced');
  if (typeof policy === 'string') return getPolicyPreset(policy);
  return policy;
}

export function analyzeReview(
  reviewInput: CanonicalReview,
  analysis: AnalysisContext = {},
  options: AnalysisOptions = {},
): AnalysisResult {
  const totalStart = nowMs();
  const review = validatedReview(reviewInput);
  const policy = resolvePolicy(options.policy);
  const model = resolveModel(options.model ?? BASELINE_MODEL);
  const now = options.now ?? analysis.now ?? new Date().toISOString();

  const normalizeStart = nowMs();
  const normalized = normalizeReview(review);
  const normalizeEnd = nowMs();

  const featureStart = nowMs();
  const features = extractFeatures(review, normalized, { ...analysis, now });
  const featureEnd = nowMs();

  const detectorStart = nowMs();
  const signals = runDetectors({
    review,
    analysis: { ...analysis, now },
    features,
    normalized,
    policy,
  });
  const detectorEnd = nowMs();

  const fusionStart = nowMs();
  const fused = fuse(signals, features, policy, model, review, { ...analysis, now });
  const score = fused.score;
  let decision = decide(score, fused.confidence, policy);
  const band = riskBand(score, policy);
  const reasons = buildReasons(signals, policy);
  const fusionEnd = nowMs();

  // Safety routing (doc 2.2/5.1): a review reporting a personal-safety
  // incident must reach the human channel. The floor is `escalate` and
  // auto-removal is bypassed regardless of score. This is a decision override,
  // not a score override — the reviewer's stored risk stays fair.
  let safety: AnalysisResult['safety'] | undefined;
  const safetySignal = signals.find((item) => item.code === 'SAFETY_REVIEW');
  if (safetySignal && policy.safety?.enabled !== false) {
    decision = decision === 'remove' ? 'escalate' : decisionAtLeast(decision, 'escalate');
    safety = {
      routed: true,
      categories: Array.isArray(safetySignal.evidence.categories)
        ? (safetySignal.evidence.categories as string[])
        : [],
      styleSuppressed:
        policy.safety?.styleSuppression !== false && (features['safety.present'] ?? 0) > 0,
    };
  }

  const provisional =
    (features['media.present'] ?? 0) > 0 && (features['media.provisional'] ?? 0) > 0;

  return {
    reviewId: review.id ?? null,
    score,
    band,
    decision,
    confidence: fused.confidence,
    dataCompleteness: fused.dataCompleteness,
    signals,
    reasons,
    familyScores: fused.familyScores,
    familyDetails: fused.familyDetails,
    modelScore: fused.modelScore,
    modelVersion: model.version,
    policyVersion: policy.version,
    provisional,
    ...(safety ? { safety } : {}),
    timings: {
      normalize: normalizeEnd - normalizeStart,
      features: featureEnd - featureStart,
      detectors: detectorEnd - detectorStart,
      fusion: fusionEnd - fusionStart,
      total: nowMs() - totalStart,
    },
  };
}

export function analyzeBatch(
  reviews: CanonicalReview[],
  analysis: AnalysisContext = {},
  options: AnalysisOptions = {},
): AnalysisResult[] {
  return reviews.map((review) => analyzeReview(review, analysis, options));
}
