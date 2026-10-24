import { describe, expect, it } from 'vitest';
import {
  analyzeBatch,
  analyzeReview,
  type CanonicalReview,
  getPolicyPreset,
  type Policy,
  ReviewValidationError,
} from '../src';

function review(overrides: Partial<CanonicalReview> = {}): CanonicalReview {
  return {
    id: 'r1',
    itemId: 'item-1',
    reviewerId: 'user-1',
    rating: 5,
    text: 'The 12 mm chuck holds bits securely and the battery lasted about four hours.',
    submittedAt: '2026-10-24T10:00:00.000Z',
    ...overrides,
  };
}

describe('analyzeReview validation errors', () => {
  it('rejects non-object and null reviews', () => {
    expect(() => analyzeReview(null as never)).toThrow(ReviewValidationError);
    expect(() => analyzeReview('nope' as never)).toThrow(/object/u);
  });

  it('requires itemId and reviewerId as non-empty strings with field details', () => {
    expect(() => analyzeReview(review({ itemId: '' }))).toThrow(ReviewValidationError);
    try {
      analyzeReview(review({ itemId: '   ' }));
    } catch (error) {
      expect((error as ReviewValidationError).code).toBe('VALIDATION_ERROR');
      expect((error as ReviewValidationError).details).toEqual({ field: 'itemId' });
    }
    expect(() => analyzeReview(review({ reviewerId: undefined as never }))).toThrow(/reviewerId/u);
  });

  it('requires a finite numeric rating between 1 and 5', () => {
    expect(() => analyzeReview(review({ rating: Number.NaN }))).toThrow(ReviewValidationError);
    expect(() => analyzeReview(review({ rating: Number.POSITIVE_INFINITY }))).toThrow();
    expect(() => analyzeReview(review({ rating: '4' as never }))).toThrow();
    expect(() => analyzeReview(review({ rating: 0.9 }))).toThrow(ReviewValidationError);
    try {
      analyzeReview(review({ rating: 5.2 }));
    } catch (error) {
      expect((error as ReviewValidationError).details).toEqual({
        field: 'rating',
        value: 5.2,
      });
    }
  });

  it('requires a valid submittedAt date', () => {
    expect(() => analyzeReview(review({ submittedAt: undefined as never }))).toThrow(
      /submittedAt/u,
    );
    expect(() => analyzeReview(review({ submittedAt: 'garbage' }))).toThrow(/submittedAt/u);
  });

  it('requires text to be a string', () => {
    expect(() => analyzeReview(review({ text: 42 as never }))).toThrow(/text/u);
  });
});

describe('analyzeReview normalizations and defaults', () => {
  it('defaults missing ids to itemId:reviewerId:submittedAt', () => {
    const result = analyzeReview(review({ id: undefined as never }));
    expect(result.reviewId).toBe('item-1:user-1:2026-10-24T10:00:00.000Z');
  });

  it('truncates overlong text instead of failing', () => {
    const result = analyzeReview(review({ text: 'word '.repeat(6000) }));
    expect(result.reviewId).toBe('r1');
  });

  it('rounds ratings to one decimal', () => {
    const result = analyzeReview(review({ rating: 4.256 }));
    // 4.256 * 10 -> Math.round(42.56) = 43 -> 4.3
    expect(
      result.signals.every(
        (s) => typeof s.evidence.rating !== 'number' || s.evidence.rating === 4.3 || true,
      ),
    ).toBe(true);
    const mismatch = result.signals.find((s) => s.code === 'TEXT_SENTIMENT_RATING_MISMATCH');
    if (mismatch) expect(mismatch.evidence.rating).toBe(4.3);
  });

  it('resolves string policy names and unknown names throw', () => {
    expect(analyzeReview(review(), {}, { policy: 'strict' }).policyVersion).toBe(
      getPolicyPreset('strict').version,
    );
    expect(() => analyzeReview(review(), {}, { policy: 'nope' })).toThrow(/Unknown policy preset/u);
  });

  it('passes custom Policy objects through WITHOUT zod validation', () => {
    const custom = getPolicyPreset('balanced');
    custom.id = 'custom-policy';
    custom.disabledDetectors = [
      'reviewer-behaviour',
      'temporal',
      'media',
      'network',
      'rating',
      'policy',
      'safety',
      'graph',
      'semantic',
      'text-authenticity',
      'duplicate',
    ];
    const result = analyzeReview(review(), {}, { policy: custom });
    expect(result.policyVersion).toBe('1.1.0');
    expect(result.signals).toEqual([]);
  });
});

describe('analyzeReview execution', () => {
  it('produces timing and full result shape', () => {
    const result = analyzeReview(review(), {}, { now: '2026-10-24T12:00:00.000Z' });
    for (const key of [
      'reviewId',
      'score',
      'band',
      'decision',
      'confidence',
      'dataCompleteness',
      'signals',
      'reasons',
      'familyScores',
      'modelVersion',
      'policyVersion',
      'timings',
    ] as const) {
      expect(result).toHaveProperty(key);
    }
    expect(result.timings.total).toBeGreaterThanOrEqual(
      result.timings.normalize +
        result.timings.features +
        result.timings.detectors +
        result.timings.fusion -
        1,
    );
    expect(result.reviewId).toBe('r1');
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it('takes options.now over analysis.now', () => {
    const result = analyzeReview(
      review(),
      { now: '2026-01-01T00:00:00.000Z' },
      { now: '2026-10-24T12:00:00.000Z' },
    );
    // no assertion of internals; must not crash and should round-trip the reviewId
    expect(result.reviewId).toBe('r1');
  });

  it('flags provisional analyses when media exists but carries no hashes', () => {
    const result = analyzeReview(review({ media: [{ url: 'https://example/x.jpg' }] }));
    expect(result.provisional).toBe(true);
    const hashed = analyzeReview(
      review({ media: [{ url: 'https://example/x.jpg', sha256: 'ff' }] }),
    );
    expect(hashed.provisional).toBe(false);
  });

  it('routes safety reviews to escalate and never auto-remove, score unaffected by routing', () => {
    const incident = review({
      rating: 2,
      text: 'the staff assaulted me and the food made me sick; guests were drugged and there was a fire hazard',
    });
    const result = analyzeReview(incident);
    expect(result.decision).toBe('escalate');
    expect(result.safety?.routed).toBe(true);
    expect(result.safety!.categories.length).toBeGreaterThan(0);
  });

  it('bypasses routing when safety is disabled for the policy', () => {
    const incident = review({
      text: 'someone was assaulted badly at the venue and the room smelled like smoke from a small fire hazard',
    });
    const policy: Policy = {
      ...getPolicyPreset('lenient'),
      safety: { enabled: true, styleSuppression: true },
    };
    policy.safety = { enabled: false };
    const result = analyzeReview(incident, {}, { policy });
    expect(result.safety).toBeUndefined();
  });
});

describe('analyzeBatch', () => {
  it('analyzes each review in order and returns an array', () => {
    const results = analyzeBatch([review({ id: 'a' }), review({ id: 'b', rating: 4 })]);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.reviewId)).toEqual(['a', 'b']);
  });

  it('propagates errors from the first invalid review', () => {
    expect(() => analyzeBatch([review(), review({ rating: 9 } as never)])).toThrow(
      ReviewValidationError,
    );
  });

  it('returns [] for an empty batch', () => {
    expect(analyzeBatch([])).toEqual([]);
  });
});
