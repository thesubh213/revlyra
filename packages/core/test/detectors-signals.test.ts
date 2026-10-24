import { describe, expect, it } from 'vitest';
import {
  type CanonicalReview,
  type DetectorContext,
  extractBehaviourFeatures,
  extractContentFeatures,
  extractMediaFeatures,
  extractNetworkFeatures,
  extractRatingFeatures,
  extractTemporalFeatures,
  mediaDetector,
  networkDetector,
  normalizeReview,
  policyDetector,
  ratingDetector,
  reviewerBehaviourDetector,
  safetyDetector,
  temporalDetector,
} from '../src';
import { baseContext, codesOf, review } from './helpers-detector';

/** Compose real extractor output for a review + analysis, like the pipeline does. */
function fullContext(
  reviewOverrides: Partial<CanonicalReview> = {},
  analysis: Parameters<typeof baseContext>[1] = {},
): DetectorContext {
  const people = review(reviewOverrides);
  const normalized = normalizeReview(people);
  const features = {
    ...extractContentFeatures(people, normalized, analysis),
    ...extractBehaviourFeatures(people, analysis),
    ...extractTemporalFeatures(people, analysis),
    ...extractNetworkFeatures(people, analysis),
    ...extractMediaFeatures(people, analysis),
    ...extractRatingFeatures(analysis.item),
  };
  return baseContext(features, analysis, people);
}

describe('reviewerBehaviourDetector thresholds', () => {
  it('requires new-account AND first review', () => {
    const fresh = fullContext(
      {},
      {
        reviewer: {
          id: 'u',
          totalReviews: 1,
          accountCreatedAt: '2026-10-24T09:00:00.000Z',
        } as never,
      },
    );
    expect(codesOf(reviewerBehaviourDetector.run(fresh))).toContain('BEH_NEW_ACCOUNT');

    const experienced = reviewerBehaviourDetector.run(
      fullContext(
        {},
        {
          reviewer: {
            id: 'u',
            totalReviews: 50,
            accountCreatedAt: '2026-10-24T09:00:00.000Z',
          } as never,
        },
      ),
    );
    expect(codesOf(experienced)).not.toContain('BEH_NEW_ACCOUNT');
  });

  it('fires velocity >= 0.3 with window counts in evidence', () => {
    const fast = fullContext(
      {},
      {
        reviewer: { id: 'u', totalReviews: 20, reviewsLast24h: 5 } as never,
      },
    );
    const signals = reviewerBehaviourDetector.run(fast);
    expect(codesOf(signals)).toContain('BEH_HIGH_VELOCITY');
    const velocitySignal = signals.find((s) => s.code === 'BEH_HIGH_VELOCITY');
    expect(velocitySignal && (velocitySignal.evidence as Record<string, unknown>).last24h).toBe(5);
  });

  it('fires rating deviation at >= 0.5 with item data', () => {
    const item = { id: 'i', totalReviews: 50, averageRating: 1.5 } as never;
    const deviated = fullContext(
      { rating: 5 },
      {
        reviewer: { id: 'u', totalReviews: 20 } as never,
        item,
      },
    );
    const signals = reviewerBehaviourDetector.run(deviated);
    expect(codesOf(signals)).toContain('BEH_RATING_DEVIATION');
    const evidence = signals.find((s) => s.code === 'BEH_RATING_DEVIATION')?.evidence as Record<
      string,
      unknown
    >;
    expect(evidence.itemAverage).toBe(1.5);
    expect(evidence.rating).toBe(5);
  });

  it('fires rating entropy only with >= 5 total reviews', () => {
    const lowN = reviewerBehaviourDetector.run(
      fullContext(
        {},
        {
          reviewer: { id: 'u', totalReviews: 4, ratingDistribution: [0, 0, 0, 0, 4] } as never,
        },
      ),
    );
    expect(codesOf(lowN)).not.toContain('BEH_RATING_ENTROPY');
    const enough = reviewerBehaviourDetector.run(
      fullContext(
        {},
        {
          reviewer: { id: 'u', totalReviews: 10, ratingDistribution: [0, 0, 0, 0, 10] } as never,
        },
      ),
    );
    expect(codesOf(enough)).toContain('BEH_RATING_ENTROPY');
  });

  it('fires five-star lockstep only with >= 10 total reviews', () => {
    const small = reviewerBehaviourDetector.run(
      fullContext(
        {},
        {
          reviewer: { id: 'u', totalReviews: 10, fiveStarRatio: 1 } as never,
        },
      ),
    );
    expect(codesOf(small)).toContain('BEH_FIVESTAR_PATTERN');

    const none = reviewerBehaviourDetector.run(
      fullContext(
        {},
        {
          reviewer: { id: 'u', totalReviews: 5, fiveStarRatio: 1 } as never,
        },
      ),
    );
    expect(codesOf(none)).not.toContain('BEH_FIVESTAR_PATTERN');
  });

  it('fires prior flags from flags or overturned appeals', () => {
    const flagged = reviewerBehaviourDetector.run(
      fullContext({}, { reviewer: { id: 'u', priorFlags: 3 } as never }),
    );
    expect(codesOf(flagged)).toContain('BEH_PRIOR_FLAGS');
    const appealed = reviewerBehaviourDetector.run(
      fullContext({}, { reviewer: { id: 'u', priorAppealsOverturned: 2 } as never }),
    );
    expect(codesOf(appealed)).toContain('BEH_PRIOR_FLAGS');
    const clean = reviewerBehaviourDetector.run(
      fullContext({}, { reviewer: { id: 'u' } as never }),
    );
    expect(codesOf(clean)).not.toContain('BEH_PRIOR_FLAGS');
  });

  it('fires category hopping only with fast velocity too', () => {
    const hopping = reviewerBehaviourDetector.run(
      fullContext(
        {},
        {
          reviewer: { id: 'u', categoryEntropy: 9, reviewsLast24h: 4 } as never,
        },
      ),
    );
    expect(codesOf(hopping)).toContain('BEH_CATEGORY_HOPPING');
    const slow = reviewerBehaviourDetector.run(
      fullContext(
        {},
        {
          reviewer: { id: 'u', categoryEntropy: 9 } as never,
        },
      ),
    );
    expect(codesOf(slow)).not.toContain('BEH_CATEGORY_HOPPING');
  });

  it('fires unverified purchases', () => {
    const f = fullContext({ verifiedPurchase: false }, {});
    expect(codesOf(reviewerBehaviourDetector.run(f))).toContain('BEH_UNVERIFIED');
  });
});

describe('temporalDetector thresholds', () => {
  it('requires a burst baseline and a strong surprise', () => {
    const burst = fullContext(
      {},
      {
        item: { id: 'i', expectedReviewsPerDay: 0.5, recentReviews24h: 30 } as never,
      },
    );
    const signals = temporalDetector.run(burst);
    expect(codesOf(signals)).toContain('TIME_PRODUCT_BURST');
    const burstSignal = signals.find((s) => s.code === 'TIME_PRODUCT_BURST');
    expect(
      burstSignal && (burstSignal.evidence as Record<string, unknown>).surprise,
    ).toBeGreaterThan(2);

    const noBaseline = temporalDetector.run(
      fullContext(
        {},
        {
          item: { id: 'i', recentReviews24h: 30 } as never,
        },
      ),
    );
    expect(codesOf(noBaseline)).not.toContain('TIME_PRODUCT_BURST');
  });

  it('fires low-CV regular posting and impossible intervals', () => {
    const regular = temporalDetector.run(
      fullContext(
        {},
        {
          reviewer: {
            id: 'u',
            totalReviews: 5,
            recentIntervalsSeconds: [59, 60, 60, 60, 61],
          } as never,
        },
      ),
    );
    expect(codesOf(regular)).toContain('TIME_LOW_INTERARRIVAL_CV');

    const machine = fullContext(
      {},
      {
        reviewer: { id: 'u', totalReviews: 9, recentIntervalsSeconds: [10, 60, 90] } as never,
      },
    );
    expect(codesOf(temporalDetector.run(machine))).toContain('TIME_IMPOSSIBLE_INTERVALS');
  });

  it('fires sync posting at 5+ within 10 minutes', () => {
    const base = new Date('2026-10-24T10:00:00.000Z').getTime();
    const signals = temporalDetector.run(
      fullContext(
        {},
        {
          reviewer: {
            id: 'u',
            totalReviews: 8,
            recentReviewTimestamps: Array.from({ length: 8 }, () => new Date(base).toISOString()),
          } as never,
        },
      ),
    );
    expect(codesOf(signals)).toContain('TIME_SYNC_POSTING');
  });

  it('fires review-after-signup within an hour', () => {
    const f = fullContext(
      {},
      {
        reviewer: { id: 'u', accountCreatedAt: '2026-10-24T09:30:00.000Z' } as never,
      },
    );
    expect(codesOf(temporalDetector.run(f))).toContain('TIME_REVIEW_AFTER_SIGNUP');
  });
});

describe('mediaDetector', () => {
  it('gates on media presence entirely', () => {
    expect(mediaDetector.run(fullContext({}, {}))).toEqual([]);
  });

  it('emits a hard exact-reuse signal from cross-account matches', () => {
    const ctx = fullContext({ media: [{ sha256: 'a' }] } as never, {
      mediaMatches: [
        { reviewId: 'o', reviewerId: 'z', itemId: 'q', kind: 'exact', distance: 0 } as never,
      ],
    });
    const signals = mediaDetector.run(ctx);
    expect(codesOf(signals)).toContain('MEDIA_EXACT_REUSE');
    expect(signals.find((s) => s.code === 'MEDIA_EXACT_REUSE')?.hard).toBe(true);
  });

  it('fires metadata-driven media signals together', () => {
    const f = fullContext(
      {
        media: [
          {
            sha256: 'x',
            capturedAt: '2020-01-01T00:00:00.000Z',
            mime: 'image/png',
            width: 1600,
            height: 800,
          },
        ],
      } as never,
      {},
    );
    const signals = mediaDetector.run(f);
    expect(codesOf(signals)).toEqual(
      expect.arrayContaining(['MEDIA_EXIF_STRIPPED', 'MEDIA_TIME_MISMATCH', 'MEDIA_SCREENSHOT']),
    );
    expect(codesOf(signals)).not.toContain('MEDIA_EXACT_REUSE');
  });
});

describe('networkDetector thresholds', () => {
  it('requires >= 2 recent accounts on a device for reuse', () => {
    const one = fullContext({ context: { recentAccountsOnDevice: 1, deviceId: 'd' } } as never, {});
    expect(codesOf(networkDetector.run(one))).not.toContain('NET_DEVICE_REUSE');
    const two = fullContext({ context: { recentAccountsOnDevice: 2, deviceId: 'd' } } as never, {});
    expect(codesOf(networkDetector.run(two))).toContain('NET_DEVICE_REUSE');
  });

  it('requires >= 10 recent accounts on a subnet (NAT caution, confidence 0.4)', () => {
    const few = fullContext(
      { context: { recentAccountsOnSubnet: 9, ip: '203.0.113.4' } } as never,
      {},
    );
    expect(codesOf(networkDetector.run(few))).not.toContain('NET_SHARED_SUBNET');
    const many = fullContext(
      { context: { recentAccountsOnSubnet: 12, ip: '203.0.113.4' } } as never,
      {},
    );
    const signals = networkDetector.run(many);
    expect(codesOf(signals)).toContain('NET_SHARED_SUBNET');
    expect(signals.find((s) => s.code === 'NET_SHARED_SUBNET')?.confidence).toBe(0.4);
  });

  it('fires headless UA, datacenter ASN, and locale mismatch signals', () => {
    const signals = networkDetector.run(
      fullContext(
        {
          context: { headlessUserAgent: true, isDatacenterAsn: true, locale: 'fr-FR' },
          language: 'en',
        } as never,
        {},
      ),
    );
    expect(codesOf(signals)).toEqual(
      expect.arrayContaining(['NET_UA_HEADLESS', 'NET_DATACENTER_ASN', 'NET_LOCALE_MISMATCH']),
    );
  });
});

describe('ratingDetector gates', () => {
  it('stays silent for excess-fivestar/anomaly below 30 sample reviews', () => {
    const noisy = ratingDetector.run(
      fullContext(
        {},
        {
          item: { id: 'i', ratingDistribution: [0, 3, 5, 4, 18] } as never,
        },
      ),
    );
    // A distribution at the noise boundary may still look bimodal; the stars
    // and chi2 signals must not fire though.
    expect(codesOf(noisy)).not.toContain('RATING_EXCESS_FIVESTAR');
    expect(codesOf(noisy)).not.toContain('RATING_DISTRIBUTION_ANOMALY');
  });

  it('fires rating signals with sufficient sample and high confidence at n >= 100', () => {
    const f = fullContext(
      {},
      {
        item: { id: 'i', ratingDistribution: [0, 0, 0, 0, 100] } as never,
      },
    );
    const signals = ratingDetector.run(f);
    expect(codesOf(signals)).toEqual(
      expect.arrayContaining(['RATING_EXCESS_FIVESTAR', 'RATING_DISTRIBUTION_ANOMALY']),
    );
    for (const signal of signals) expect(signal.confidence).toBe(0.85);
  });

  it('uses lower confidence between 30 and 99 samples', () => {
    const f = fullContext(
      {},
      {
        item: { id: 'i', ratingDistribution: [0, 0, 0, 0, 50] } as never,
      },
    );
    const signals = ratingDetector.run(f);
    expect(signals.length).toBeGreaterThan(0);
    for (const signal of signals) expect(signal.confidence).toBe(0.6);
  });
});

describe('policyDetector incentives, suppression, and contact details', () => {
  function policySignals(reviewOverrides: Partial<CanonicalReview>) {
    const _people = review(reviewOverrides);
    return policyDetector.run(fullContext(reviewOverrides, {}));
  }

  it('sums incentive pattern weights into one signal', () => {
    const signals = policySignals({
      text: 'free product in exchange for your included review today',
    });
    const incentive = signals.find((s) => s.code === 'POLICY_INCENTIVE_LANGUAGE');
    expect(incentive).toBeTruthy();
    expect(incentive && (incentive.evidence as Record<string, unknown>).patterns).toBeTruthy();
  });

  it('fires conditional incentive for sentiment-conditioned offers', () => {
    const signals = policySignals({
      text: 'we can give you a discount after a five star rating arrives on this purchase',
    });
    expect(codesOf(signals)).toContain('POLICY_CONDITIONAL_INCENTIVE');
  });

  it('fires suppression offers for refund-for-edit and legal threats', () => {
    const signals = policySignals({
      text: 'we will refund your money after you remove the review and edit the rating to five stars',
    });
    expect(codesOf(signals)).toContain('POLICY_REVIEW_SUPPRESSION_OFFER');
  });

  it('fires undisclosed insiders with self-assert severity', () => {
    const signals = policySignals({
      reviewerRelationship: 'employee',
      text: 'i work for the company that sells this template and the boss helps',
    });
    const insider = signals.find((s) => s.code === 'POLICY_UNDISCLOSED_INSIDER');
    expect(insider?.severity).toBe(0.35);
    expect(insider && (insider.evidence as Record<string, unknown>).selfAsserted).toBe(true);
  });

  it('treats declared customers as not insider', () => {
    const signals = policySignals({
      text: 'plain text review here',
      reviewerRelationship: 'customer',
    });
    expect(codesOf(signals)).not.toContain('POLICY_UNDISCLOSED_INSIDER');
  });

  it('fires gating evidence and engagement purchase metadata', () => {
    const signals = policySignals({ metadata: { gateFunnel: true, purchasedEngagement: true } });
    expect(codesOf(signals)).toEqual(
      expect.arrayContaining(['POLICY_GATING_EVIDENCE', 'POLICY_ENGAGEMENT_PURCHASE']),
    );
  });

  it('fires contact info from masked contact counts', () => {
    const signals = policySignals({
      text: 'chat with me sales@acme.example or 8005551234 plus https://go.example now',
    });
    const contact = signals.find((s) => s.code === 'POLICY_CONTACT_INFO');
    expect(contact).toBeTruthy();
    const evidence = contact?.evidence as Record<string, unknown>;
    expect(evidence.urls).toBe(1);
    expect(evidence.emails).toBe(1);
    expect(evidence.phones).toBe(1);
  });
});

describe('safetyDetector', () => {
  function safetySignals(reviewOverrides: Partial<CanonicalReview>) {
    return safetyDetector.run(fullContext(reviewOverrides, {}));
  }

  it('routes multi-category incidents with sorted categories and hit counts', () => {
    {
      const signals = safetySignals({
        text: 'the staff assaulted me, the food made me sick, guests were stolen from, and there was a fire hazard',
      });
      const safety = signals.find((s) => s.code === 'SAFETY_REVIEW');
      expect(safety?.family).toBe('policy');
      const evidence = safety?.evidence as Record<string, unknown>;
      expect(Array.isArray(evidence.categories)).toBe(true);
      expect((evidence.categories as string[]).length).toBeGreaterThanOrEqual(2);
      expect(evidence.categories as string[]).toEqual(
        [...((evidence.categories as string[]) ?? [])].sort(),
      );
      expect((evidence.hits as number) ?? 0).toBeGreaterThan(0);
      expect(typeof evidence.distressStyle).toBe('boolean');
    }
  });

  it('is silent for clean reviews', () => {
    expect(
      safetySignals({
        text: 'everything about this park was delightful for the whole family today',
      }),
    ).toEqual([]);
  });

  it('is disabled with the detector id or the policy family toggle', () => {
    const people = review({ text: 'assaulted badly at the venue' });
    const base = fullContext({ text: 'the person assaulted me publicly' }, {});
    // detector disabled
    const withIdDisabled = {
      ...base,
      policy: { ...base.policy, disabledDetectors: ['safety'] },
    };
    expect(safetyDetector.run(withIdDisabled)).toEqual([]);
    // family disabled
    const withFamilyDisabled = {
      ...baseContext(base.features, base.analysis, people),
      policy: { ...baseContext().policy, disabledFamilies: ['policy' as never] },
    };
    expect(safetyDetector.run(withFamilyDisabled)).toEqual([]);
  });

  it('grows severity with each category and hit', () => {
    const single = safetySignals({ text: 'someone assaulted me during the tour' });
    const triple = safetySignals({
      text: 'someone assaulted me, the food made everyone sick, and a fire started in the lobby',
    });
    // severity = min(0.95, 0.5 + 0.15*(categories-1) + 0.05*hits)
    const singleSev = single[0]?.severity ?? 0;
    const singleEvidence = single[0]!.evidence as { categories: string[]; hits: number };
    expect(singleSev).toBeCloseTo(
      0.5 + 0.15 * (singleEvidence.categories.length - 1) + 0.05 * singleEvidence.hits,
      8,
    );
    const tripleEvidence = triple[0]!.evidence as { categories: string[]; hits: number };
    expect(triple[0]?.severity).toBeCloseTo(
      0.5 + 0.15 * (tripleEvidence.categories.length - 1) + 0.05 * tripleEvidence.hits,
      8,
    );
    expect(triple[0]?.severity).toBeGreaterThan(singleSev);
  });
});
