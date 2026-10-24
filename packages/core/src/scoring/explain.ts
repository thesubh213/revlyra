import type { Policy, Reason, Signal } from '../types';

export function buildReasons(signals: Signal[], policy: Policy): Reason[] {
  const reasons = signals.map((item) => {
    const weight = policy.familyWeights[item.family];
    const contribution = weight * item.severity * item.confidence;
    return {
      code: item.code,
      family: item.family,
      contribution: Number(contribution.toFixed(4)),
      severity: item.severity,
      confidence: item.confidence,
      message: item.explanation,
      evidence: item.evidence,
    } satisfies Reason;
  });

  return reasons.sort((a, b) => b.contribution - a.contribution);
}

export function topReasons(reasons: Reason[], limit = 5): Reason[] {
  return reasons.slice(0, limit);
}
