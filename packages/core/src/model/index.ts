import type { FeatureSet, ModelArtifact } from '../types';
import baseline from './baseline.json';

export const BASELINE_MODEL: ModelArtifact = baseline as ModelArtifact;

export function resolveModel(input?: ModelArtifact): ModelArtifact {
  return input ?? BASELINE_MODEL;
}

export function sigmoid(value: number): number {
  if (value >= 0) {
    const z = Math.exp(-value);
    return 1 / (1 + z);
  }
  const z = Math.exp(value);
  return z / (1 + z);
}

export function logit(probability: number): number {
  const clamped = Math.min(1 - 1e-9, Math.max(1e-9, probability));
  return Math.log(clamped / (1 - clamped));
}

export function scoreModel(features: FeatureSet, model: ModelArtifact): number {
  let value = model.intercept;
  for (const [name, weight] of Object.entries(model.weights)) {
    const feature = features[name];
    if (feature === undefined || !Number.isFinite(feature)) continue;
    value += weight * feature;
  }
  return sigmoid(value);
}

export function calibrate(probability: number, model: ModelArtifact): number {
  if (model.calibration.kind === 'identity' || !model.calibration.knots?.length) {
    return probability;
  }
  const knots = [...model.calibration.knots].sort((a, b) => a.x - b.x);
  if (probability <= (knots[0]?.x ?? 0)) return knots[0]?.y ?? probability;
  const last = knots[knots.length - 1]!;
  if (probability >= last.x) return last.y;
  for (let i = 1; i < knots.length; i += 1) {
    const left = knots[i - 1]!;
    const right = knots[i]!;
    if (probability <= right.x) {
      const span = right.x - left.x;
      if (span <= 0) return right.y;
      const t = (probability - left.x) / span;
      return left.y + t * (right.y - left.y);
    }
  }
  return probability;
}
