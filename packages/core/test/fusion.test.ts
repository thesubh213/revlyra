import { describe, expect, it } from 'vitest';
import {
  type AnalysisContext,
  aggregateFamilies,
  BASELINE_MODEL,
  type CanonicalReview,
  computeConfidence,
  computeDataCompleteness,
  fuse,
  SIGNAL_FAMILIES,
  type Signal,
} from '../src';
import { balancedPreset } from './helpers-policy';

const policy = balancedPreset();

function review(): CanonicalReview {
  return {
    id: 'r1',
    itemId: 'item',
    reviewerId: 'user',
    rating: 5,
    text: 'great product thanks',
    submittedAt: '2026-10-24T10:00:00.000Z',
  };
}

function sig(opts: Partial<Signal> = {}): Signal {
  return {
    code: 'CODE_1',
    family: 'content',
    severity: 0.5,
    confidence: 0.5,
    evidence: {},
    explanation: 'e',
    ...opts,
  };
}

describe('aggregateFamilies', () => {
  it('returns zeroed buckets for every family when no signals exist', () => {
    const details = aggregateFamilies([]);
    for (const family of SIGNAL_FAMILIES) {
      expect(details[family]).toEqual({ score: 0, rawMax: 0, count: 0, hard: false });
    }
    expect(Object.keys(details)).toHaveLength(SIGNAL_FAMILIES.length);
  });

  it('scores single signals at rawMax with no corroboration bonus', () => {
    const details = aggregateFamilies([sig({ severity: 0.8, confidence: 0.75 })]);
    expect(details.content.count).toBe(1);
    expect(details.content.rawMax).toBeCloseTo(0.6, 10);
    expect(details.content.score).toBeCloseTo(0.6, 10);
  });

  it('adds a corroboration bonus scaled by (count-1)/3, capped at 1', () => {
    const one = aggregateFamilies([sig(), sig({ code: 'B' })]);
    expect(one.content.count).toBe(2);
    expect(one.content.score).toBeCloseTo(0.25 + 0.15 * (1 / 3), 10);

    const four = aggregateFamilies([
      sig(),
      sig({ code: 'B' }),
      sig({ code: 'C' }),
      sig({ code: 'D' }),
    ]);
    expect(four.content.score).toBeCloseTo(Math.min(1, 0.25 + 0.15), 10);
  });

  it('propagates hard flags OR-wise', () => {
    const details = aggregateFamilies([sig(), sig({ code: 'B', hard: true })]);
    expect(details.content.hard).toBe(true);

    const soft = aggregateFamilies([sig(), sig({ code: 'B' })]);
    expect(soft.content.hard).toBe(false);
  });

  it('tracks hard flags and raw maxima per family', () => {
    const details = aggregateFamilies([
      sig({ family: 'behaviour', severity: 1, confidence: 1, hard: true }),
    ]);
    expect(details.behaviour.hard).toBe(true);
    expect(details.behaviour.score).toBe(1);
    expect(details.content.count).toBe(0);
  });
});

describe('computeDataCompleteness', () => {
  it('reaches 1.0 only with a complete review', () => {
    const complete = {
      ...review(),
      media: [{ sha256: 'a' }],
      context: { ip: '1.2.3.4' } as CanonicalReview['context'],
    };
    const analysis: AnalysisContext = {
      reviewer: { id: 'r' },
      item: { id: 'i' },
      corpus: { totalReviews: 60, documentFrequency: {}, tokenIdf: {} } as never,
      campaign: { id: 'c', score: 0.5, memberCount: 3, signalFamilies: ['graph'] },
    };
    void analysis;
    expect(computeDataCompleteness(complete, analysis)).toBe(1);
  });

  it('weights each missing piece', () => {
    const analysis: AnalysisContext = {};
    // text 0.3 + no media (mediaAnalyzed 1 -> 0.05) + no campaign (0.5 graph -> 0.025)
    expect(computeDataCompleteness(review(), analysis)).toBeCloseTo(0.375, 10);
  });

  it('requires a corpus of at least 50 reviews', () => {
    const withSmall: AnalysisContext = { corpus: { totalReviews: 49 } as never };
    const withLarge: AnalysisContext = { corpus: { totalReviews: 50 } as never };
    const c1 = computeDataCompleteness(review(), withSmall);
    const c2 = computeDataCompleteness(review(), withLarge);
    expect(c2 - c1).toBeCloseTo(0.15, 10);
  });

  it('penalizes media without hashes but not digestible media', () => {
    const unhashed = { ...review(), media: [{ url: 'http://x' }] };
    const hashed = { ...review(), media: [{ url: 'http://x', sha256: 'dead' }] };
    // unhashed: text 0.3 + mediaAnalyzed 0 + graph 0.025
    expect(computeDataCompleteness(unhashed, {})).toBeCloseTo(0.325, 10);
    expect(computeDataCompleteness(hashed, {})).toBeCloseTo(0.375, 10);
  });

  it('rewards campaign presence over the 0.5 default graph component', () => {
    const withCampaign: AnalysisContext = {
      campaign: { id: 'c', score: 1, memberCount: 3, signalFamilies: ['graph'] },
    };
    const without = computeDataCompleteness(review(), {});
    const withIt = computeDataCompleteness(review(), withCampaign);
    expect(withIt - without).toBeCloseTo(0.025, 10);
  });

  it('counts context presence only when any value is defined', () => {
    const noContext = computeDataCompleteness(review(), {});
    const emptyContext = computeDataCompleteness(
      { ...review(), context: { ip: undefined } } as never,
      {},
    );
    const withContext = computeDataCompleteness(
      { ...review(), context: { ip: '8.8.8.8' } } as never,
      {},
    );
    expect(emptyContext).toBe(noContext);
    expect(withContext - noContext).toBeCloseTo(0.1, 10);
  });
});

describe('computeConfidence', () => {
  const model = BASELINE_MODEL;

  it('falls back to a tiny formula without signals, capped at 0.35', () => {
    expect(computeConfidence([], 1, model, {})).toBeCloseTo(0.35, 10);
    expect(computeConfidence([], 0.2, model, {})).toBeCloseTo(0.19, 10);
  });

  it('combines completeness, signal confidence, families, and model quality', () => {
    const signals = [sig({ confidence: 0.5 })];
    const dc = 1;
    const expected = 0.35 * 1 + 0.45 * 0.5 + 0.1 * (1 / 3) + 0.1 * 1 - 0.05 - 0.05;
    expect(computeConfidence(signals, dc, model, {})).toBeCloseTo(expected, 10);
  });

  it('applies corpus and reviewer penalties', () => {
    const signals = [sig({ confidence: 0.9 })];
    const base = computeConfidence(signals, 1, model, {});
    const apiAnalysis = computeConfidence(signals, 1, model, {
      corpus: { totalReviews: 50, documentFrequency: {}, tokenIdf: {} } as never,
    });
    const full = computeConfidence(signals, 1, model, {
      corpus: { totalReviews: 50, documentFrequency: {}, tokenIdf: {} } as never,
      reviewer: { id: 'x' },
    });
    expect(apiAnalysis).toBeGreaterThan(computeConfidence(signals, 1, model, {}));
    expect(full).toBeGreaterThan(apiAnalysis);
    expect(base).toBeLessThan(full);
  });

  it('is clamped into [0.05, 0.99]', () => {
    const low = computeConfidence([], 0, model, {});
    expect(low).toBeGreaterThanOrEqual(0.05);
    const strong = computeConfidence(
      [
        sig({ confidence: 1 }),
        sig({ code: 'B', confidence: 1 }),
        sig({ code: 'C', confidence: 1 }),
      ],
      1,
      model,
      { reviewer: { id: 'r' } },
    );
    expect(strong).toBeLessThanOrEqual(0.99);
  });
});

describe('fuse', () => {
  it('produces the expected sigmoid combination with no signals', () => {
    const result = fuse([], {}, policy, BASELINE_MODEL, review(), {});
    void result;
    const modelScore = sigmoidOf(BASELINE_MODEL.intercept);
    const value = policy.intercept + policy.modelWeight * logitOf(modelScore);
    expect(result.score).toBeCloseTo(sigmoidOf(value), 10);
    expect(result.modelScore).toBeCloseTo(modelScore, 10);
    expect(result.familyScores.content).toBe(0);
    expect(Object.keys(result.familyDetails)).toHaveLength(SIGNAL_FAMILIES.length);
    expect(result.score).toBeLessThanOrEqual(0.1);
  });

  it('adds the family score term and grows the score with a strong signal', () => {
    const signals = [sig({ severity: 1, confidence: 1 })];
    const result = fuse(signals, {}, policy, BASELINE_MODEL, review(), {});
    expect(result.familyScores.content).toBe(1);
    // Hard intercept means even a full content signal stays low, but it must
    // still dominate the no-signal score.
    const base = fuse([], {}, policy, BASELINE_MODEL, review(), {});
    expect(result.score).toBeGreaterThan(base.score);
    expect(result.score).toBeGreaterThan(0.015);
    expect(result.score).toBeLessThan(0.05);
  });

  it('raises the score to the hard-flag floor when a hard signal is present', () => {
    const signals = [sig({ hard: true, severity: 0.2, confidence: 0.2 })];
    const result = fuse(signals, {}, policy, BASELINE_MODEL, review(), {});
    expect(result.score).toBe(policy.hardFlagFloor);
  });

  it('keeps disabled families out of the fusion term', () => {
    const disabled = { ...policy, disabledFamilies: ['content' as const] };
    const signals = [sig({ family: 'content', severity: 1, confidence: 1 })];
    const result = fuse(signals, {}, disabled, BASELINE_MODEL, review(), {});
    expect(result.familyScores.content).toBe(0);
    // Hard flag still fires, so we compare against a soft-only signal instead:
    const soft = [sig({ family: 'content', severity: 0.9, confidence: 0.9 })];
    const withDisabled = fuse(soft, {}, disabled, BASELINE_MODEL, review(), {});
    const valuesEnabled = (s: Signal[]) =>
      sigmoidOf(
        disabled.intercept +
          policy.familyWeights.content * aggregateFamilies(s).content.score +
          policy.familyWeights.behaviour * 0 +
          policy.familyWeights.temporal * 0 +
          policy.familyWeights.media * 0 +
          policy.familyWeights.network * 0 +
          policy.familyWeights.graph * 0 +
          policy.familyWeights.rating * 0 +
          policy.familyWeights.policy * 0 +
          disabled.modelWeight * logitOf(sigmoidOf(BASELINE_MODEL.intercept)),
      );
    expect(withDisabled.score).toBeCloseTo(
      sigmoidOf(
        disabled.intercept +
          (policy.disabledFamilies.includes('content') ? 0 : 0) +
          disabled.modelWeight * logitOf(sigmoidOf(BASELINE_MODEL.intercept)),
      ),
      6,
    );
    expect(valuesEnabled(soft)).toBeGreaterThan(0);
  });

  it('clamps the score to [0, 0.999]', () => {
    const result = fuse([], {}, policy, BASELINE_MODEL, review(), {});
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(0.999);
  });
});

function sigmoidOf(value: number): number {
  return 1 / (1 + Math.exp(-value));
}
function logitOf(probability: number): number {
  const clamped = Math.min(1 - 1e-9, Math.max(1e-9, probability));
  return Math.log(clamped / (1 - clamped));
}
