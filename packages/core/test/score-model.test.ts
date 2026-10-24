import { describe, expect, it } from 'vitest';
import {
  BASELINE_MODEL,
  buildReasons,
  calibrate,
  logit,
  type ModelArtifact,
  resolveModel,
  type Signal,
  scoreModel,
  sigmoid,
  topReasons,
} from '../src';
import { balancedPreset } from './helpers-policy';

describe('resolveModel', () => {
  it('falls back to the baseline artifact', () => {
    expect(resolveModel()).toBe(BASELINE_MODEL);
  });

  it('passes through custom artifacts', () => {
    const custom: ModelArtifact = {
      version: 'test.1',
      featureSpecVersion: '0',
      intercept: 0,
      weights: {},
      calibration: { kind: 'identity' },
    };
    expect(resolveModel(custom)).toBe(custom);
  });
});

describe('BASELINE_MODEL shape', () => {
  it('is calibrated and has a 2026.10.1 version with 39 weights', () => {
    expect(BASELINE_MODEL.version).toBe('2026.10.1');
    expect(BASELINE_MODEL.featureSpecVersion).toBe('1.0.0');
    expect(BASELINE_MODEL.intercept).toBe(-3.05);
    expect(Object.keys(BASELINE_MODEL.weights)).toHaveLength(39);
    expect(BASELINE_MODEL.calibration.kind).toBe('identity');
    expect(BASELINE_MODEL.metrics?.calibrationStatus).toBe(1);
  });
});

describe('sigmoid', () => {
  it('maps 0 to 0.5', () => {
    expect(sigmoid(0)).toBe(0.5);
  });

  it('is monotonic and numerically stable at both extremes', () => {
    expect(sigmoid(700)).toBeCloseTo(1, 12);
    expect(sigmoid(-700)).toBeCloseTo(0, 12);
    expect(sigmoid(2)).toBeGreaterThan(sigmoid(1));
    expect(sigmoid(-1)).toBeLessThan(sigmoid(-0.5));
  });

  it('known logistic values', () => {
    expect(sigmoid(1)).toBeCloseTo(0.7310585786300049, 12);
    expect(sigmoid(-1)).toBeCloseTo(0.2689414213699951, 12);
  });
});

describe('logit', () => {
  it('inverts sigmoid within a tolerance', () => {
    for (const p of [0.01, 0.1, 0.4, 0.5, 0.6, 0.9, 0.99]) {
      expect(sigmoid(logit(p))).toBeCloseTo(p, 10);
      // logit(sigmoid(x)) recovers x.
      expect(logit(sigmoid(p))).toBeCloseTo(p, 8);
    }
  });

  it('clamps inputs inside (0,1) instead of taking log(0) or log(inf)', () => {
    expect(logit(0)).toBeLessThan(0);
    expect(logit(1)).toBeGreaterThan(20);
    expect(logit(0)).toBeLessThan(-20);
    expect(Number.isFinite(logit(0))).toBe(true);
    expect(Number.isFinite(logit(1))).toBe(true);
  });

  it('maps 0.5 to 0', () => {
    expect(logit(0.5)).toBe(0);
  });
});

describe('scoreModel', () => {
  const model = BASELINE_MODEL;

  it('returns the sigmoid of the intercept-only value for empty features', () => {
    expect(scoreModel({}, model)).toBe(sigmoid(model.intercept));
  });

  it('accumulates finite feature contributions', () => {
    const anchorWeight = model.weights['text.exactDup'] ?? 0;
    if (anchorWeight !== 0) {
      expect(scoreModel({ 'text.exactDup': 1 }, model)).toBeGreaterThan(scoreModel({}, model));
    }
  });

  it('skips undefined features and non-finite values', () => {
    const withNan = scoreModel(
      { 'text.exactDup': Number.NaN, 'text.nearDup': Number.POSITIVE_INFINITY },
      model,
    );
    expect(withNan).toBe(scoreModel({}, model));
    expect(scoreModel({ 'not.a.feature': 999 }, model)).toBe(scoreModel({}, model));
  });

  it('honors a custom model intercept and weights', () => {
    const custom: ModelArtifact = {
      version: 'x',
      featureSpecVersion: 'x',
      intercept: 1,
      weights: { feature: 2 },
      calibration: { kind: 'identity' },
    };
    expect(scoreModel({ feature: 0.5 }, custom)).toBe(sigmoid(2));
    expect(scoreModel({ feature: -0.5 }, custom)).toBe(sigmoid(0));
  });
});

describe('calibrate', () => {
  it('is identity for identity calibration regardless of knots', () => {
    const model: ModelArtifact = {
      version: 'x',
      featureSpecVersion: 'x',
      intercept: 0,
      weights: {},
      calibration: { kind: 'identity', knots: [{ x: 0.5, y: 0.1 }] },
    };
    expect(calibrate(0.9, model)).toBe(0.9);
  });

  const isotonic: ModelArtifact = {
    version: 'x',
    featureSpecVersion: 'x',
    intercept: 0,
    weights: {},
    calibration: {
      kind: 'isotonic',
      knots: [
        { x: 0.5, y: 0.4 },
        { x: 0.1, y: 0.2 },
        { x: 0.9, y: 0.8 },
      ],
    },
  };

  it('sorts knots internally and clamps below the first and above the last', () => {
    expect(calibrate(0.05, isotonic)).toBe(0.2);
    expect(calibrate(0.95, isotonic)).toBe(0.8);
    expect(calibrate(0.1, isotonic)).toBe(0.2);
    expect(calibrate(0.9, isotonic)).toBe(0.8);
  });

  it('linearly interpolates between knots', () => {
    expect(calibrate(0.3, isotonic)).toBeCloseTo(0.3, 12);
    expect(calibrate(0.5, isotonic)).toBeCloseTo(0.4, 12);
    expect(calibrate(0.7, isotonic)).toBeCloseTo(0.6, 12);
  });

  it('handles degenerate knots through the boundary checks', () => {
    const degenerate: ModelArtifact = {
      version: 'x',
      featureSpecVersion: 'x',
      intercept: 0,
      weights: {},
      calibration: {
        kind: 'isotonic',
        knots: [
          { x: 0.1, y: 0.2 },
          { x: 0.1, y: 0.6 },
        ],
      },
    };
    // x=0.1 equals the first knot -> pre-loop check returns the FIRST y.
    expect(calibrate(0.1, degenerate)).toBe(0.2);
    // Anything above 0.1 hits the last-knot check -> the LAST y.
    expect(calibrate(0.2, degenerate)).toBe(0.6);
  });

  it('isotonic with no knots behaves as identity', () => {
    const empty: ModelArtifact = {
      ...isotonic,
      calibration: { kind: 'isotonic', knots: [] },
    };
    expect(calibrate(0.42, empty)).toBe(0.42);
  });
});

describe('buildReasons', () => {
  const policy = balancedPreset();

  function signal(
    code: string,
    family: Signal['family'],
    severity: number,
    confidence: number,
  ): Signal {
    return {
      code,
      family,
      severity,
      confidence,
      evidence: {},
      explanation: `explained ${code}`,
    };
  }

  it('computes contribution as familyWeight * severity * confidence, rounded to 4 dp', () => {
    const reasons = buildReasons(
      [signal('X', 'graph', 0.5, 0.5), signal('Y', 'policy', 0.25, 0.4)],
      policy,
    );
    expect(reasons.map((r) => r.contribution)).toEqual([
      Number((2.1 * 0.25).toFixed(4)), // graph weight 2.1
      Number((0.9 * 0.1).toFixed(4)), // policy weight 0.9
    ]);
    expect(reasons[0]?.message).toBe('explained X');
  });

  it('sorts descending by contribution', () => {
    const reasons = buildReasons(
      [signal('LOW', 'network', 0.2, 0.2), signal('HIGH', 'media', 0.9, 0.9)],
      policy,
    );
    expect(reasons[0]?.code).toBe('HIGH');
    expect(reasons[1]?.code).toBe('LOW');
  });

  it('produces zero contribution for zero-weight families', () => {
    const zeroPolicy = {
      ...policy,
      familyWeights: { ...policy.familyWeights, policy: 0 },
    };
    const reasons = buildReasons([signal('Z', 'policy', 0.9, 0.9)], zeroPolicy);
    expect(reasons[0]?.contribution).toBe(0);
  });

  it('rounds to 4 decimals', () => {
    const reasons = buildReasons([signal('Q', 'rating', 1 / 3, 1 / 3)], policy);
    // 1.1 * 1/9 = 0.12222222 -> 0.1222
    expect(reasons[0]?.contribution).toBeCloseTo(0.1222, 4);
  });
});

describe('topReasons', () => {
  const base = {
    code: 'X',
    family: 'content' as const,
    severity: 1,
    confidence: 1,
    message: 'm',
    evidence: {},
  };

  it('defaults to the top five', () => {
    const reasons = Array.from({ length: 7 }, (_, i) => ({ ...base, code: `C${i}` }));
    const top = topReasons(reasons);
    expect(top).toHaveLength(5);
    expect(top[0]?.code).toBe('C0');
    expect(top[4]?.code).toBe('C4');
  });

  it('honors custom limits, empty lists, and over-length limits', () => {
    expect(topReasons([], 3)).toEqual([]);
    expect(topReasons([base], 3)).toHaveLength(1);
    expect(topReasons([base], 0)).toEqual([]);
  });
});
