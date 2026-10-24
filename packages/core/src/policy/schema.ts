import { z } from 'zod';
import type { Policy } from '../types';

const familyWeightsSchema = z.object({
  content: z.number().min(0).max(20),
  behaviour: z.number().min(0).max(20),
  temporal: z.number().min(0).max(20),
  media: z.number().min(0).max(20),
  network: z.number().min(0).max(20),
  graph: z.number().min(0).max(20),
  rating: z.number().min(0).max(20),
  policy: z.number().min(0).max(20),
});

const thresholdsSchema = z.object({
  label: z.number().min(0).max(1),
  downrank: z.number().min(0).max(1),
  hold: z.number().min(0).max(1),
  remove: z.number().min(0).max(1),
  escalate: z.number().min(0).max(1),
});

export const safetyConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    styleSuppression: z.boolean().optional(),
  })
  .optional();

export const integrityConfigSchema = z
  .object({
    recencyHalfLifeDays: z.number().min(0).max(3650).optional(),
    verifiedBoost: z.number().min(0.5).max(2).optional(),
    unverifiedFactor: z.number().min(0.5).max(1).optional(),
    ensureCritical: z.boolean().optional(),
  })
  .optional();

export const policySchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  familyWeights: familyWeightsSchema,
  modelWeight: z.number().min(0).max(10),
  intercept: z.number().min(-20).max(20),
  thresholds: thresholdsSchema,
  hardFlagFloor: z.number().min(0).max(1),
  minConfidenceForRemove: z.number().min(0).max(1),
  autoRemove: z.boolean(),
  safety: safetyConfigSchema,
  integrity: integrityConfigSchema,
  disabledDetectors: z.array(z.string()),
  disabledFamilies: z.array(
    z.enum(['content', 'behaviour', 'temporal', 'media', 'network', 'graph', 'rating', 'policy']),
  ),
});

export function validatePolicy(input: unknown): Policy {
  return policySchema.parse(input) as Policy;
}

export function mergePolicy(base: Policy, override: Partial<Policy>): Policy {
  return validatePolicy({
    ...base,
    ...override,
    familyWeights: { ...base.familyWeights, ...(override.familyWeights ?? {}) },
    thresholds: { ...base.thresholds, ...(override.thresholds ?? {}) },
    safety: { ...(base.safety ?? {}), ...(override.safety ?? {}) },
    integrity: { ...(base.integrity ?? {}), ...(override.integrity ?? {}) },
  });
}
