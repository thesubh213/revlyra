import { describe, expect, it } from 'vitest';
import { extractFeatures, normalizeReview } from '../src';

function review(overrides: Record<string, unknown> = {}) {
  return {
    id: 'r',
    itemId: 'i',
    reviewerId: 'u',
    rating: 4,
    text: 'ok english',
    submittedAt: '2026-10-24T10:00:00.000Z',
    ...overrides,
  } as never;
}

describe('extractFeatures (composite + meta keys)', () => {
  it('merges every extractor without key collisions and adds meta flags', () => {
    const r = review();
    const f = extractFeatures(r, normalizeReview(r), {});
    expect(f['meta.languageEn']).toBe(1);
    expect(f['meta.hasMedia']).toBe(0);
    expect(f['meta.hasReviewerProfile']).toBe(0);
    expect(f['meta.hasItemProfile']).toBe(0);
    expect(f['meta.hasCorpus']).toBe(0);
    expect(f['meta.textLength']).toBeGreaterThan(0);
    expect(f['meta.languageConfidence']).toBeGreaterThan(0);
    for (const prefix of ['text.', 'beh.', 'temp.', 'net.', 'media.', 'rating.', 'meta.']) {
      expect(Object.keys(f).some((k) => k.startsWith(prefix))).toBe(true);
    }
  });

  it('flips meta flags based on the analysis', () => {
    const r = review({ media: [{ url: 'x' }] });
    const f = extractFeatures(r, normalizeReview(r), {
      reviewer: { id: 'u' } as never,
      item: { id: 'i' } as never,
      corpus: { totalReviews: 50, documentFrequency: {}, tokenIdf: {} } as never,
    });
    expect(f['meta.hasMedia']).toBe(1);
    expect(f['meta.hasReviewerProfile']).toBe(1);
    expect(f['meta.hasItemProfile']).toBe(1);
    expect(f['meta.hasCorpus']).toBe(1);
  });

  it('marks meta.languageEn = 0 for detected or forced non-English', () => {
    const forced = review({ language: 'fr' });
    expect(extractFeatures(forced, normalizeReview(forced as never), {})['meta.languageEn']).toBe(
      0,
    );
  });

  it('requires >= 50 corpus reviews for meta.hasCorpus', () => {
    const r = review();
    const small = extractFeatures(r, normalizeReview(r), {
      corpus: { totalReviews: 49, documentFrequency: {}, tokenIdf: {} } as never,
    });
    expect(small['meta.hasCorpus']).toBe(0);
    const large = extractFeatures(r, normalizeReview(r), {
      corpus: { totalReviews: 50, documentFrequency: {}, tokenIdf: {} } as never,
    });
    expect(large['meta.hasCorpus']).toBe(1);
  });
});
