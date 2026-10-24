import type { Signal, SignalFamily } from '../types';

export function signal(
  code: string,
  family: SignalFamily,
  severity: number,
  confidence: number,
  explanation: string,
  evidence: Record<string, unknown> = {},
  hard = false,
): Signal {
  return {
    code,
    family,
    severity: Math.min(1, Math.max(0, severity)),
    confidence: Math.min(1, Math.max(0, confidence)),
    evidence,
    explanation,
    ...(hard ? { hard: true } : {}),
  };
}

export function isEnabled(
  detectorId: string,
  policy: { disabledDetectors: string[]; disabledFamilies: SignalFamily[] },
  family: SignalFamily,
): boolean {
  return (
    !policy.disabledDetectors.includes(detectorId) && !policy.disabledFamilies.includes(family)
  );
}
