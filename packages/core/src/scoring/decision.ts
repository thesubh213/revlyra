import type { DecisionKind, Policy, RiskBand } from '../types';

export function decide(score: number, confidence: number, policy: Policy): DecisionKind {
  const { thresholds } = policy;
  if (score >= thresholds.remove) {
    return policy.autoRemove && confidence >= policy.minConfidenceForRemove ? 'remove' : 'escalate';
  }
  if (score >= thresholds.escalate) return 'escalate';
  if (score >= thresholds.hold) return 'hold';
  if (score >= thresholds.downrank) return 'downrank';
  if (score >= thresholds.label) return 'label';
  return 'allow';
}

export function riskBand(score: number, policy: Policy): RiskBand {
  if (score >= policy.thresholds.escalate) return 'critical';
  if (score >= policy.thresholds.hold) return 'high';
  if (score >= policy.thresholds.label) return 'medium';
  return 'low';
}
