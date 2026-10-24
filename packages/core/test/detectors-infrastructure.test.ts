import { describe, expect, it } from 'vitest';
import {
  DETECTORS,
  type Detector,
  duplicateDetector,
  graphDetector,
  isEnabled,
  mediaDetector,
  networkDetector,
  policyDetector,
  ratingDetector,
  reviewerBehaviourDetector,
  runDetectors,
  SIGNAL_FAMILIES,
  safetyDetector,
  semanticDetector,
  signal,
  temporalDetector,
  textAuthenticityDetector,
} from '../src';
import type { Signal } from '../src/types';
import { baseContext, codesOf, review } from './helpers-detector';

describe('detector registry', () => {
  it('registers all 11 detectors in pipeline order with families', () => {
    expect(DETECTORS.map((d) => d.id)).toEqual([
      'duplicate',
      'text-authenticity',
      'reviewer-behaviour',
      'temporal',
      'media',
      'network',
      'rating',
      'policy',
      'safety',
      'graph',
      'semantic',
    ]);
    for (const detector of DETECTORS) {
      expect(detector.version).toMatch(/^[0-9.]+$/u);
      for (const family of detector.families) {
        expect(SIGNAL_FAMILIES).toContain(family);
      }
    }
  });

  it('declares unique ids', () => {
    expect(new Set(DETECTORS.map((d) => d.id)).size).toBe(DETECTORS.length);
  });

  const byId = (id: string) => DETECTORS.find((d) => d.id === id)!;
  it('families coverage: safety detector is registered under the policy family', () => {
    expect(byId('safety').families).toEqual(['policy']);
    expect(byId('semantic').families).toEqual(['content']);
    expect(byId('graph').families).toEqual(['graph']);
  });

  it('individual detectors export sensible metadata', () => {
    expect(duplicateDetector.id).toBe('duplicate');
    expect(textAuthenticityDetector.version).toBe('1.1.0');
    expect(reviewerBehaviourDetector.id).toBe('reviewer-behaviour');
    expect(temporalDetector.id).toBe('temporal');
    expect(mediaDetector.id).toBe('media');
    expect(networkDetector.id).toBe('network');
    expect(ratingDetector.id).toBe('rating');
    expect(policyDetector.version).toBe('1.1.0');
    expect(safetyDetector.version).toBe('1.0.0');
    expect(graphDetector.version).toBe('1.0.0');
    expect(semanticDetector.version).toBe('1.0.0');
  });
});

describe('signal helper', () => {
  it('clamps severity and confidence into [0,1]', () => {
    const s = signal('X', 'content', 2, -1, 'e');
    expect(s.severity).toBe(1);
    expect(s.confidence).toBe(0);
    expect(s.hard).toBeUndefined();
    expect(s.evidence).toEqual({});
  });

  it('adds the hard key only when requested', () => {
    const hard = signal('X', 'content', 0.5, 0.5, 'e', {}, true);
    expect(hard.hard).toBe(true);
    const soft = signal('X', 'content', 0.5, 0.5, 'e', {}, false);
    expect(soft).not.toHaveProperty('hard');
  });
});

describe('isEnabled', () => {
  it('returns false when the detector or family is disabled', () => {
    expect(isEnabled('duplicate', { disabledDetectors: [], disabledFamilies: [] }, 'content')).toBe(
      true,
    );
    expect(
      isEnabled('duplicate', { disabledDetectors: ['duplicate'], disabledFamilies: [] }, 'content'),
    ).toBe(false);
    expect(
      isEnabled('duplicate', { disabledDetectors: [], disabledFamilies: ['content'] }, 'content'),
    ).toBe(false);
  });
});

describe('runDetectors', () => {
  it('sorts signals by severity*confidence descending', () => {
    const result = runDetectors(
      baseContext({
        'text.exactDup': 1,
        'beh.unverified': 1,
      }),
    );
    const weights = result.map((s) => s.severity * s.confidence);
    for (let i = 1; i < weights.length; i += 1) {
      expect(weights[i - 1]).toBeGreaterThanOrEqual(weights[i]);
    }
    expect(result[0]?.hard).toBe(true);
    expect(codesOf(result)).toContain('TEXT_EXACT_DUPLICATE_CROSS_ACCOUNT');
  });

  it('honors disabledFamilies even when the detector itself is enabled', () => {
    const result = runDetectors(
      baseContext({ 'text.exactDup': 1 }, {}, undefined, {
        disabledFamilies: ['content'],
      } as never),
    );
    expect(codesOf(result)).not.toContain('TEXT_EXACT_DUPLICATE_CROSS_ACCOUNT');
  });

  it('honors custom detector lists', () => {
    const only = runDetectors(baseContext({ 'beh.unverified': 1 }), [duplicateDetector]);
    expect(only).toEqual([]);
  });

  it('swallows detector errors but reports them with the debug flag', () => {
    const bomb: Detector = {
      id: 'bomb',
      version: '1',
      families: ['content'],
      run() {
        throw new Error('boom');
      },
    };
    const hidden = runDetectors(baseContext(), [bomb]);
    expect(hidden).toEqual([]);
    const policyWithDebug = { analysis: { metadata: { debugDetectorErrors: true } } } as never;
    void policyWithDebug;
    const exposed = runDetectors(
      {
        ...baseContext(),
        analysis: { metadata: { debugDetectorErrors: true } },
      },
      [bomb],
    );
    expect(exposed).toHaveLength(1);
    expect(exposed[0]?.code).toBe('DETECTOR_ERROR');
    expect(exposed[0]?.severity).toBe(0);
    expect((exposed[0]!.evidence as Record<string, unknown>).error).toContain('boom');
  });

  it('runs with an empty policy field set without crashing', () => {
    const result = runDetectors({
      ...baseContext(),
      policy: {
        id: 't',
        version: 't',
        familyWeights: {
          content: 1,
          behaviour: 1,
          temporal: 1,
          media: 1,
          network: 1,
          graph: 1,
          rating: 1,
          policy: 1,
        },
        modelWeight: 1,
        intercept: 0,
        thresholds: { label: 0.3, downrank: 0.55, hold: 0.75, remove: 0.95, escalate: 0.85 },
        hardFlagFloor: 0.8,
        minConfidenceForRemove: 0.6,
        autoRemove: false,
        disabledDetectors: [
          'duplicate',
          'text-authenticity',
          'reviewer-behaviour',
          'temporal',
          'media',
          'network',
          'rating',
          'policy',
          'safety',
          'graph',
          'semantic',
        ],
        disabledFamilies: [],
      },
    });
    expect(result).toEqual([]);
  });

  it('propagates review data into evidence', () => {
    const result = runDetectors(baseContext({ 'beh.unverified': 1 }));
    const unverified = result.find((s) => s.code === 'BEH_UNVERIFIED') as Signal;
    expect(unverified.evidence.verifiedPurchase).toBe(null);
  });

  it('supports a custom review', () => {
    const result = runDetectors(
      baseContext({ 'beh.unverified': 1 }, {}, review({ verifiedPurchase: false })),
    );
    const unverified = result.find((s) => s.code === 'BEH_UNVERIFIED') as Signal;
    expect(unverified.evidence.verifiedPurchase).toBe(false);
  });
});
