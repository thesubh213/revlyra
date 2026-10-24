import { CODES } from '../codes';
import { SAFETY_INCIDENT_PATTERNS } from '../features/lexicons';
import type { Detector, DetectorContext, Signal } from '../types';
import { isEnabled, signal } from './helpers';

/**
 * Public-safety routing detector (doc 2.2/5.1: safety warnings — assault,
 * drugging, foodborne illness, fires — must reach a human review channel and
 * must never be silently demoted or auto-removed by presentation filters).
 *
 * The signal lives in the policy family (low weight) so that a routed review's
 * risk score stays fair; the pipeline escalates the *decision* based on the
 * code, not on score inflation.
 */
function run(ctx: DetectorContext): Signal[] {
  if (!isEnabled('safety', ctx.policy, 'policy')) return [];
  if ((ctx.features['safety.present'] ?? 0) <= 0) return [];

  const categories = new Map<string, number>();
  for (const pattern of SAFETY_INCIDENT_PATTERNS) {
    const re = new RegExp(pattern.re.source, pattern.re.flags);
    let match: RegExpExecArray | null = re.exec(ctx.normalized.text);
    let count = 0;
    while (match !== null) {
      count += 1;
      if (match[0].length === 0) break;
      match = re.exec(ctx.normalized.text);
    }
    if (count > 0) categories.set(pattern.category, count);
  }
  if (categories.size === 0) return [];

  const totalHits = Array.from(categories.values()).reduce((sum, value) => sum + value, 0);
  const severity = Math.min(0.95, 0.5 + 0.15 * (categories.size - 1) + 0.05 * totalHits);

  return [
    signal(
      CODES.SAFETY_REVIEW,
      'policy',
      severity,
      0.75,
      'The review reports a personal-safety incident. Routed to the human safety channel; not scored as fraud evidence.',
      {
        categories: Array.from(categories.keys()).sort(),
        hits: totalHits,
        distressStyle: (ctx.features['safety.distressStyle'] ?? 0) > 0,
      },
    ),
  ];
}

export const safetyDetector: Detector = {
  id: 'safety',
  version: '1.0.0',
  families: ['policy'],
  run,
};
