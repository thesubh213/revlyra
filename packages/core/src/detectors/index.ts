import type { Detector, DetectorContext, Signal, SignalFamily } from '../types';
import { reviewerBehaviourDetector } from './behaviour';
import { duplicateDetector } from './duplicate';
import { graphDetector } from './graph';
import { mediaDetector } from './media';
import { networkDetector } from './network';
import { policyDetector } from './policy';
import { ratingDetector } from './rating';
import { safetyDetector } from './safety';
import { semanticDetector } from './semantic';
import { temporalDetector } from './temporal';
import { textAuthenticityDetector } from './text';

export const DETECTORS: Detector[] = [
  duplicateDetector,
  textAuthenticityDetector,
  reviewerBehaviourDetector,
  temporalDetector,
  mediaDetector,
  networkDetector,
  ratingDetector,
  policyDetector,
  safetyDetector,
  graphDetector,
  semanticDetector,
];

export const SIGNAL_FAMILIES: SignalFamily[] = [
  'content',
  'behaviour',
  'temporal',
  'media',
  'network',
  'graph',
  'rating',
  'policy',
];

export function runDetectors(ctx: DetectorContext, detectors: Detector[] = DETECTORS): Signal[] {
  const signals: Signal[] = [];
  for (const detector of detectors) {
    if (ctx.policy.disabledDetectors.includes(detector.id)) continue;
    try {
      const produced = detector.run(ctx);
      for (const item of produced) {
        if (!ctx.policy.disabledFamilies.includes(item.family)) signals.push(item);
      }
    } catch (error) {
      // A misbehaving custom detector must not take down the pipeline.
      if (ctx.analysis.metadata?.debugDetectorErrors === true) {
        signals.push({
          code: 'DETECTOR_ERROR',
          family: 'content',
          severity: 0,
          confidence: 0,
          evidence: { detector: detector.id, error: String(error) },
          explanation: `Detector ${detector.id} failed.`,
        });
      }
    }
  }
  return signals.sort((a, b) => b.severity * b.confidence - a.severity * a.confidence);
}

export * from './behaviour';
export * from './duplicate';
export * from './graph';
export * from './helpers';
export * from './media';
export * from './network';
export * from './policy';
export * from './rating';
export * from './safety';
export * from './semantic';
export * from './temporal';
export * from './text';
