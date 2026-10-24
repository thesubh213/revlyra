import { getPolicyPreset, normalizeReview } from '../src';
import type {
  AnalysisContext,
  CanonicalReview,
  DetectorContext,
  FeatureSet,
  Policy,
} from '../src/types';

export function review(overrides: Partial<CanonicalReview> = {}): CanonicalReview {
  return {
    id: 'r',
    itemId: 'item',
    reviewerId: 'user',
    rating: 5,
    text: 'This product worked exactly as promised and the battery lasted four hours.',
    submittedAt: '2026-10-24T10:00:00.000Z',
    ...overrides,
  };
}

export function policy(_overrides: Partial<Policy> = {}): Policy {
  return getPolicyPreset('balanced');
}

export function baseContext(
  features: FeatureSet = {},
  analysis: AnalysisContext = {},
  people = review(),
  policyOverrides?: Partial<Policy>,
): DetectorContext {
  return {
    review: people,
    analysis,
    features,
    normalized: normalizeReview(people),
    policy: policyOverrides ? { ...policy(), ...policyOverrides } : policy(),
  };
}

export function codesOf(signals: Array<{ code: string }>): string[] {
  return signals.map((item) => item.code);
}
