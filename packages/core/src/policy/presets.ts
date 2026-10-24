import type { Policy } from '../types';
import { mergePolicy, validatePolicy } from './schema';

const BASE: Policy = {
  id: 'balanced',
  version: '1.1.0',
  familyWeights: {
    content: 2.8,
    behaviour: 2.2,
    temporal: 1.7,
    media: 2.4,
    network: 0.7,
    graph: 2.1,
    rating: 1.1,
    policy: 0.9,
  },
  modelWeight: 1.1,
  intercept: -3.3,
  thresholds: {
    label: 0.3,
    downrank: 0.55,
    hold: 0.75,
    remove: 0.95,
    escalate: 0.85,
  },
  hardFlagFloor: 0.82,
  minConfidenceForRemove: 0.6,
  autoRemove: false,
  // Safety routing on by default: incident reports escalate to the human
  // channel and are never auto-removed (doc 2.2/5.1).
  safety: { enabled: true, styleSuppression: true },
  // Recency + verified weighting defaults (doc 1/5.1).
  integrity: {
    recencyHalfLifeDays: 120,
    verifiedBoost: 1.15,
    unverifiedFactor: 0.9,
    ensureCritical: true,
  },
  disabledDetectors: [],
  disabledFamilies: [],
};

const PRESETS: Record<string, Policy> = {
  balanced: BASE,
  strict: mergePolicy(BASE, {
    id: 'strict',
    familyWeights: { ...BASE.familyWeights, content: 3.1, graph: 2.5, media: 2.7 },
    intercept: -2.9,
    thresholds: { label: 0.2, downrank: 0.4, hold: 0.6, remove: 0.9, escalate: 0.72 },
    integrity: { recencyHalfLifeDays: 120, ensureCritical: false },
  }),
  lenient: mergePolicy(BASE, {
    id: 'lenient',
    familyWeights: { ...BASE.familyWeights, content: 2.4, graph: 1.6, network: 0.4 },
    intercept: -3.8,
    thresholds: { label: 0.4, downrank: 0.65, hold: 0.82, remove: 0.97, escalate: 0.9 },
    integrity: { recencyHalfLifeDays: 200 },
  }),
  marketplace: mergePolicy(BASE, {
    id: 'marketplace',
    familyWeights: {
      ...BASE.familyWeights,
      content: 3,
      media: 2.7,
      graph: 2.4,
      rating: 1.3,
    },
    integrity: { recencyHalfLifeDays: 90 },
  }),
  'local-business': mergePolicy(BASE, {
    id: 'local-business',
    familyWeights: {
      ...BASE.familyWeights,
      content: 2.5,
      behaviour: 2.4,
      temporal: 2.1,
      network: 0.5,
      media: 1.8,
      policy: 1.2,
    },
    integrity: { recencyHalfLifeDays: 150 },
  }),
  'app-store': mergePolicy(BASE, {
    id: 'app-store',
    familyWeights: { ...BASE.familyWeights, content: 2.9, graph: 2.2, temporal: 1.9 },
  }),
  travel: mergePolicy(BASE, {
    id: 'travel',
    familyWeights: { ...BASE.familyWeights, media: 2.9, temporal: 2.1, content: 2.6, policy: 1.1 },
    integrity: { recencyHalfLifeDays: 90 },
  }),
};

export function getPolicyPreset(name: string): Policy {
  const preset = PRESETS[name];
  if (!preset) {
    throw new Error(
      `Unknown policy preset "${name}". Available: ${Object.keys(PRESETS).join(', ')}`,
    );
  }
  return validatePolicy(preset);
}

export function listPolicyPresets(): string[] {
  return Object.keys(PRESETS);
}

export function isPolicyPreset(name: string): boolean {
  return name in PRESETS;
}
