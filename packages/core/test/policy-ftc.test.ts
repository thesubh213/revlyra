import { describe, expect, it } from 'vitest';
import { analyzeReview } from '../src';

const BASE_REVIEW = {
  itemId: 'item-1',
  reviewerId: 'user-1',
  submittedAt: '2026-10-24T10:00:00Z',
};

describe('FTC 16 CFR §465 compliance signals', () => {
  it('detects sentiment-conditioned incentives (§465.4)', () => {
    const result = analyzeReview(
      {
        ...BASE_REVIEW,
        rating: 5,
        text: "You'll love this! The seller will send you a $20 gift card if you leave a positive review after buying.",
      },
      {},
      { now: '2026-10-25T00:00:00Z' },
    );
    const signal = result.signals.find((item) => item.code === 'POLICY_CONDITIONAL_INCENTIVE');
    expect(signal).toBeTruthy();
    expect(signal!.evidence.patterns.length).toBeGreaterThan(0);
  });

  it('detects offers to trade refunds for review edits (§465.7)', () => {
    const result = analyzeReview(
      {
        ...BASE_REVIEW,
        rating: 1,
        text: 'After my complaint they finally said we will give you a full refund if you delete your review.',
      },
      {},
      { now: '2026-10-25T00:00:00Z' },
    );
    const signal = result.signals.find((item) => item.code === 'POLICY_REVIEW_SUPPRESSION_OFFER');
    expect(signal).toBeTruthy();
  });

  it('flags a declared insider relationship without disclosure (§465.5)', () => {
    const result = analyzeReview(
      {
        ...BASE_REVIEW,
        rating: 5,
        text: 'Absolutely wonderful unit, exceeded every expectation and I recommend it to everyone looking for a premium choice.',
        reviewerRelationship: 'employee',
      },
      {},
      { now: '2026-10-25T00:00:00Z' },
    );
    const signal = result.signals.find((item) => item.code === 'POLICY_UNDISCLOSED_INSIDER');
    expect(signal).toBeTruthy();
    expect(signal!.evidence.disclosurePresent).toBe(false);
  });

  it('does not flag when the material connection is disclosed', () => {
    const result = analyzeReview(
      {
        ...BASE_REVIEW,
        rating: 4,
        text: 'Sponsored post: I received a free unit in exchange for this honest review. Solid build, good value for the price.',
        reviewerRelationship: 'employee',
      },
      {},
      { now: '2026-10-25T00:00:00Z' },
    );
    expect(result.signals.some((item) => item.code === 'POLICY_UNDISCLOSED_INSIDER')).toBe(false);
  });

  it('maps caller metadata to gating and engagement evidence (§465.8)', () => {
    const result = analyzeReview(
      {
        ...BASE_REVIEW,
        rating: 5,
        text: 'Excellent in every way, truly a five star experience that I cannot recommend enough!',
        metadata: { gateFunnel: true, purchasedEngagement: true },
      },
      {},
      { now: '2026-10-25T00:00:00Z' },
    );
    expect(result.signals.some((item) => item.code === 'POLICY_GATING_EVIDENCE')).toBe(true);
    expect(result.signals.some((item) => item.code === 'POLICY_ENGAGEMENT_PURCHASE')).toBe(true);
  });
});
