import { describe, expect, it } from 'vitest';
import { SELECTION_EXCLUSION_REASONS, selectReviews } from '../src';
import type { ScoredReviewInput } from '../src/types';

function uniqueText(seed: string): string {
  // Disjoint token pools per seed so two texts never accidentally cluster.
  const offset = [...seed].reduce((a, c) => a + c.charCodeAt(0), 0) * 50;
  return Array.from({ length: 20 }, (_, i) => `qt${offset + i}`).join(' ');
}

function reviewOf(overrides: Partial<ScoredReviewInput> & { id: string }): ScoredReviewInput {
  return {
    rating: 5,
    text: uniqueText(overrides.id),
    submittedAt: '2026-10-01T00:00:00.000Z',
    trustScore: 0.9,
    decision: 'allow',
    ...overrides,
  };
}

describe('selectReviews option handling', () => {
  const input = Array.from({ length: 12 }, (_, i) =>
    reviewOf({ id: `r${i}`, rating: (i % 5) + 1 }),
  );

  it('clamps the limit into [1, 100] (0 -> 1, 150 -> 100 impossible here)', () => {
    const zero = selectReviews(input, { limit: 0, ensureCritical: false, diversify: false });
    expect(zero.reviews).toHaveLength(1);
    const big = selectReviews(input, { limit: 150, ensureCritical: false, diversify: false });
    expect(big.reviews).toHaveLength(12); // all inputs
  });

  it('clamps minTrust into [0, 1]', () => {
    const high = selectReviews(input, { minTrust: 1.4 });
    const max = selectReviews(input, { minTrust: 1 });
    expect(high.excluded).toBe(max.excluded);
  });

  it('excludes reviews below minTrust BEFORE any other rule (flagged cannot rescue)', () => {
    const input2 = [
      reviewOf({ id: 'low', trustScore: 0.1, decision: 'allow' }),
      reviewOf({ id: 'flag', trustScore: 0.5, decision: 'hold' }),
    ];
    const result = selectReviews(input2, { minTrust: 0.3 });
    expect(result.exclusions.map((e) => e.reason)).toEqual([
      SELECTION_EXCLUSION_REASONS.BELOW_MIN_TRUST,
      SELECTION_EXCLUSION_REASONS.FLAGGED_DECISION,
    ]);
    expect(result.reviews).toHaveLength(0);
  });

  it('exclude honorable hold/remove/escalate decisions unless includeFlagged', () => {
    const input2 = [reviewOf({ id: 'held', decision: 'hold' })];
    expect(selectReviews(input2).reviews).toHaveLength(0);
    expect(selectReviews(input2, { includeFlagged: true }).reviews).toHaveLength(1);
  });

  it('records CAPACITY_LIMIT for leftovers', () => {
    const result = selectReviews(input, { limit: 1, ensureCritical: false });
    const capacity = result.exclusions.filter(
      (e) => e.reason === SELECTION_EXCLUSION_REASONS.CAPACITY_LIMIT,
    );
    expect(capacity.length).toBe(input.length - result.reviews.length);
    expect(capacity[0]?.detail).toBe('selection limit reached (1)');
  });
});

describe('selectReviews clustering', () => {
  it('collapses exact and near duplicates into one cluster keeping the best', () => {
    const base = reviewOf({ id: 'a', trustScore: 0.5 });
    const copy = reviewOf({ id: 'b', trustScore: 0.9, text: base.text });
    const result = selectReviews([base, copy], { limit: 5, ensureCritical: false });
    expect(result.clusters).toBe(1);
    expect(result.reviews).toHaveLength(1);
    expect(result.reviews[0]?.id).toBe('b'); // higher trust representative
    expect(result.exclusions.find((e) => e.reviewId === 'a')?.reason).toBe(
      SELECTION_EXCLUSION_REASONS.DUPLICATE_CLUSTER,
    );
  });

  it('clusters short near-dupes by token jaccard', () => {
    const a = reviewOf({ id: 'a', text: 'great product works fine' });
    const b = reviewOf({ id: 'b', text: 'great product works fine now' });
    const result = selectReviews([a, b], { limit: 5, ensureCritical: false });
    expect(result.clusters).toBe(1);
  });
});

describe('selectReviews critical bucket guarantee', () => {
  function mixedInputs(): ScoredReviewInput[] {
    return Array.from({ length: 10 }, (_, i) => reviewOf({ id: `p${i}`, rating: 4 }));
  }

  it('injects a missing 1-star review even at capacity by displacing the weakest', () => {
    const critical = reviewOf({ id: 'crit', rating: 1, trustScore: 0.4 });
    const positives = mixedInputs();
    const all = [...positives, critical];
    const result = selectReviews(all, { limit: 10, diversify: false });
    expect(result.reviews.some((r) => r.id === 'crit')).toBe(true);
    expect(result.reviews).toHaveLength(10);
    expect(
      result.exclusions.some(
        (e) => e.reason === SELECTION_EXCLUSION_REASONS.REPLACED_FOR_CRITICAL_COVERAGE,
      ),
    ).toBe(true);
  });

  it('never displaces critial reviews already selected', () => {
    const crit1 = reviewOf({ id: 'crit1', rating: 1, trustScore: 0.99 });
    const crit2 = reviewOf({
      id: 'crit2',
      rating: 2,
      trustScore: 0.98,
      text: 'Two stars and rather poor product quality overall here',
    });
    const positives = Array.from({ length: 5 }, (_, i) => reviewOf({ id: `p${i}`, rating: 5 }));
    const result = selectReviews([crit1, crit2, ...positives], {
      limit: 2,
      diversify: false,
      ensureCritical: true,
    });
    expect(result.reviews.map((r) => r.id)).toContain('crit1');
  });
});

describe('selectReviews scoring and ordering', () => {
  it('handles invalid dates via the fixed 0.5 recency fallback', () => {
    const a = reviewOf({ id: 'a', submittedAt: 'not-a-date' });
    const result = selectReviews([a], { ensureCritical: false });
    expect(result.reviews).toHaveLength(1);
    expect(result.reviews[0]?.selectionScore).toBeGreaterThan(0);
  });

  it('diversify: false sorts purely by score', () => {
    const inputs = [
      reviewOf({ id: 'high', trustScore: 1, helpfulness: 1 }),
      reviewOf({ id: 'mid', trustScore: 0.5, helpfulness: 0.5 }),
      reviewOf({ id: 'low', trustScore: 0.1, helpfulness: 0.1 }),
    ];
    const result = selectReviews(inputs, { diversify: false, ensureCritical: false });
    expect(result.reviews.map((r) => r.id)).toEqual(['high', 'mid', 'low']);
  });

  it('counts aspects from the aspect lexicon substring scan', () => {
    const result = selectReviews(
      [
        reviewOf({
          id: 'a',
          text: 'the battery life was bad and shipping was slow but the price is right',
        }),
      ],
      { ensureCritical: false },
    );
    expect(result.aspectsCovered).toEqual(expect.arrayContaining(['battery', 'shipping', 'price']));
    expect(result.reviews[0]?.selectionReason).toContain('battery');
  });

  it('ignores media count and language fields', () => {
    const a = reviewOf({ id: 'a', mediaCount: 2, language: 'de' });
    expect(selectReviews([a]).reviews).toHaveLength(1);
  });

  it('carries decision multipliers into selection order', () => {
    const labeled = reviewOf({
      id: 'labeled',
      trustScore: 0.95,
      helpfulness: 0.6,
      decision: 'label',
    });
    const allowed = reviewOf({
      id: 'allowed',
      trustScore: 0.95,
      helpfulness: 0.6,
      decision: 'allow',
      text: 'Nice one product works every single day',
    });
    const result = selectReviews([labeled, allowed], {
      diversify: false,
      ensureCritical: false,
      limit: 2,
    });
    expect(result.reviews.map((r) => r.id)).toEqual(['allowed', 'labeled']);
    expect(result.reviews[0]?.selectionScore).toBeGreaterThan(
      result.reviews[1]?.selectionScore ?? 0,
    );
  });
});
