import { describe, expect, it } from 'vitest';
import {
  getPolicyPreset,
  isPolicyPreset,
  listPolicyPresets,
  mergePolicy,
  validatePolicy,
} from '../src';
import { balancedPreset } from './helpers-policy';

describe('listPolicyPresets', () => {
  it('exposes the seven named presets in registry order', () => {
    expect(listPolicyPresets()).toEqual([
      'balanced',
      'strict',
      'lenient',
      'marketplace',
      'local-business',
      'app-store',
      'travel',
    ]);
  });
});

describe('isPolicyPreset', () => {
  it('accepts every listed preset and rejects unknown names', () => {
    for (const name of listPolicyPresets()) expect(isPolicyPreset(name)).toBe(true);
    expect(isPolicyPreset('sneaky')).toBe(false);
    expect(isPolicyPreset('')).toBe(false);
    expect(isPolicyPreset('balanced ')).toBe(false);
  });

  it('is a plain `name in` check, so object prototype keys pass', () => {
    // Documents the current behavior: prototype-chain members are not excluded.
    expect(isPolicyPreset('toString')).toBe(true);
  });
});

describe('getPolicyPreset', () => {
  it('returns the balanced preset with documented default weights', () => {
    const policy = getPolicyPreset('balanced');
    expect(policy.id).toBe('balanced');
    expect(policy.version).toBe('1.1.0');
    expect(policy.familyWeights).toEqual({
      content: 2.8,
      behaviour: 2.2,
      temporal: 1.7,
      media: 2.4,
      network: 0.7,
      graph: 2.1,
      rating: 1.1,
      policy: 0.9,
    });
    expect(policy.modelWeight).toBe(1.1);
    expect(policy.intercept).toBe(-3.3);
    expect(policy.thresholds).toEqual({
      label: 0.3,
      downrank: 0.55,
      hold: 0.75,
      remove: 0.95,
      escalate: 0.85,
    });
    expect(policy.hardFlagFloor).toBe(0.82);
    expect(policy.minConfidenceForRemove).toBe(0.6);
    expect(policy.autoRemove).toBe(false);
    expect(policy.safety).toEqual({ enabled: true, styleSuppression: true });
    expect(policy.integrity).toEqual({
      recencyHalfLifeDays: 120,
      verifiedBoost: 1.15,
      unverifiedFactor: 0.9,
      ensureCritical: true,
    });
    expect(policy.disabledDetectors).toEqual([]);
    expect(policy.disabledFamilies).toEqual([]);
  });

  it('strict tightens thresholds and disables the critical-slot guarantee', () => {
    const policy = getPolicyPreset('strict');
    expect(policy.id).toBe('strict');
    expect(policy.thresholds).toEqual({
      label: 0.2,
      downrank: 0.4,
      hold: 0.6,
      remove: 0.9,
      escalate: 0.72,
    });
    expect(policy.familyWeights.content).toBe(3.1);
    expect(policy.familyWeights.graph).toBe(2.5);
    expect(policy.familyWeights.media).toBe(2.7);
    expect(policy.intercept).toBe(-2.9);
    expect(policy.integrity?.ensureCritical).toBe(false);
    // untouched limits are inherited from balanced
    expect(policy.familyWeights.network).toBe(0.7);
    expect(policy.autoRemove).toBe(false);
  });

  it('lenient widens thresholds and extends recency half-life', () => {
    const policy = getPolicyPreset('lenient');
    expect(policy.id).toBe('lenient');
    expect(policy.thresholds.label).toBe(0.4);
    expect(policy.thresholds.hold).toBe(0.82);
    expect(policy.thresholds.remove).toBe(0.97);
    expect(policy.integrity?.recencyHalfLifeDays).toBe(200);
    expect(policy.familyWeights.content).toBe(2.4);
    expect(policy.familyWeights.network).toBe(0.4);
  });

  it('marketplace / local-business / app-store / travel each adjust their niche', () => {
    const marketplace = getPolicyPreset('marketplace');
    expect(marketplace.familyWeights.content).toBe(3);
    expect(marketplace.familyWeights.media).toBe(2.7);
    expect(marketplace.integrity?.recencyHalfLifeDays).toBe(90);

    const local = getPolicyPreset('local-business');
    expect(local.familyWeights.policy).toBe(1.2);
    expect(local.familyWeights.temporal).toBe(2.1);
    expect(local.integrity?.recencyHalfLifeDays).toBe(150);

    const appStore = getPolicyPreset('app-store');
    expect(appStore.familyWeights.content).toBe(2.9);
    expect(appStore.familyWeights.temporal).toBe(1.9);

    const travel = getPolicyPreset('travel');
    expect(travel.familyWeights.media).toBe(2.9);
    expect(travel.familyWeights.policy).toBe(1.1);
    expect(travel.integrity?.recencyHalfLifeDays).toBe(90);
  });

  it('throws an Unknown-policy-preset error naming the available options', () => {
    expect(() => getPolicyPreset('nonsense')).toThrowError(
      'Unknown policy preset "nonsense". Available: balanced, strict, lenient, marketplace, local-business, app-store, travel',
    );
  });
});

describe('validatePolicy', () => {
  it('round-trips a valid policy and keeps unknown nested data (defaults filled)', () => {
    const policy = balancedPreset();
    const parsed = validatePolicy(policy);
    expect(parsed).toEqual(policy);
  });

  it('rejects out-of-range family weights and model weights', () => {
    expect(() =>
      validatePolicy({
        ...balancedPreset(),
        familyWeights: { ...balancedPreset().familyWeights, content: 20.5 },
      }),
    ).toThrow();
    expect(() => validatePolicy({ ...balancedPreset(), modelWeight: 10.5 })).toThrow();
    expect(() => validatePolicy({ ...balancedPreset(), intercept: -21 })).toThrow();
    // Boundary values are accepted.
    expect(() => validatePolicy({ ...balancedPreset(), intercept: -20 })).not.toThrow();
    expect(() => validatePolicy({ ...balancedPreset(), modelWeight: 0 })).not.toThrow();
  });

  it('rejects thresholds above 1 and below 0', () => {
    expect(() =>
      validatePolicy({
        ...balancedPreset(),
        thresholds: { ...balancedPreset().thresholds, hold: 1.01 },
      }),
    ).toThrow();
    expect(() =>
      validatePolicy({
        ...balancedPreset(),
        thresholds: { ...balancedPreset().thresholds, label: -0.01 },
      }),
    ).toThrow();
    expect(() =>
      validatePolicy({
        ...balancedPreset(),
        thresholds: { ...balancedPreset().thresholds, label: 0 },
      }),
    ).not.toThrow();
    expect(() =>
      validatePolicy({
        ...balancedPreset(),
        thresholds: { ...balancedPreset().thresholds, hold: 1 },
      }),
    ).not.toThrow();
  });

  it('rejects malformed integrity configs', () => {
    expect(() =>
      validatePolicy({ ...balancedPreset(), integrity: { recencyHalfLifeDays: 4000 } }),
    ).toThrow();
    expect(() =>
      validatePolicy({ ...balancedPreset(), integrity: { verifiedBoost: 1.9 } }),
    ).not.toThrow();
    expect(() =>
      validatePolicy({ ...balancedPreset(), integrity: { verifiedBoost: 2.1 } }),
    ).toThrow();
    expect(() =>
      validatePolicy({ ...balancedPreset(), integrity: { unverifiedFactor: 0.4 } }),
    ).toThrow();
    expect(() =>
      validatePolicy({ ...balancedPreset(), integrity: { recencyHalfLifeDays: 0 } }),
    ).not.toThrow();
    expect(() =>
      validatePolicy({ ...balancedPreset(), integrity: { recencyHalfLifeDays: 3650 } }),
    ).not.toThrow();
  });

  it('rejects unknown values in disabledFamilies', () => {
    const policy = balancedPreset();
    expect(() =>
      validatePolicy({ ...policy, disabledFamilies: ['nonexistent' as never] }),
    ).toThrow();
    expect(() => validatePolicy({ ...policy, disabledFamilies: ['graph'] })).not.toThrow();
  });

  it('rejects policies missing required fields', () => {
    expect(() => validatePolicy({ ...balancedPreset(), id: '' })).toThrow();
    expect(() => validatePolicy({ ...balancedPreset(), version: '' })).toThrow();
    expect(() =>
      validatePolicy({ ...balancedPreset(), autoRemove: 'yes' as unknown as boolean }),
    ).toThrow();
  });
});

describe('mergePolicy', () => {
  it('shallow-merges nested objects instead of replacing them', () => {
    const merged = mergePolicy(getPolicyPreset('balanced'), {
      familyWeights: { content: 3 },
      thresholds: { label: 0.1 },
      integrity: { recencyHalfLifeDays: 60 },
      safety: { styleSuppression: false },
    });
    expect(merged.familyWeights.content).toBe(3);
    expect(merged.familyWeights.graph).toBe(2.1); // inherited
    expect(merged.thresholds.label).toBe(0.1);
    expect(merged.thresholds.hold).toBe(0.75); // inherited
    expect(merged.integrity?.recencyHalfLifeDays).toBe(60);
    expect(merged.integrity?.verifiedBoost).toBe(1.15); // inherited
    expect(merged.safety?.styleSuppression).toBe(false);
    expect(merged.safety?.enabled).toBe(true); // inherited
  });

  it('overrides scalar fields wholesale', () => {
    const merged = mergePolicy(getPolicyPreset('balanced'), {
      id: 'custom',
      version: '9.9',
      modelWeight: 4,
      intercept: 1,
      hardFlagFloor: 0.5,
      minConfidenceForRemove: 0.2,
      autoRemove: true,
      disabledDetectors: ['duplicate'],
    });
    expect(merged.id).toBe('custom');
    expect(merged.version).toBe('9.9');
    expect(merged.modelWeight).toBe(4);
    expect(merged.intercept).toBe(1);
    expect(merged.hardFlagFloor).toBe(0.5);
    expect(merged.minConfidenceForRemove).toBe(0.2);
    expect(merged.autoRemove).toBe(true);
    expect(merged.disabledDetectors).toEqual(['duplicate']);
  });

  it('still validates the merged result', () => {
    expect(() => mergePolicy(getPolicyPreset('balanced'), { intercept: -100 })).toThrow();
  });
});
