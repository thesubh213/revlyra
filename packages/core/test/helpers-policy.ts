import { getPolicyPreset } from '../src';
import type { Policy } from '../src/types';

/** Returns a deep-enough copy of the balanced preset so tests cannot mutate the module registry. */
export function balancedPreset(): Policy {
  const policy = getPolicyPreset('balanced');
  return JSON.parse(JSON.stringify(policy)) as Policy;
}
