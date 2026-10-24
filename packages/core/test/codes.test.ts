import { describe, expect, it } from 'vitest';
import {
  ALL_SIGNAL_CODES,
  CODES,
  GENERIC_BASELINE,
  isSignalCode,
  SELECTION_EXCLUSION_REASONS,
} from '../src';

describe('CODES registry (public API contract — codes are never renamed)', () => {
  it('every entry is a self-named string constant', () => {
    for (const [key, value] of Object.entries(CODES)) {
      expect(value).toBe(key);
    }
  });

  it('contains exactly 49 stable codes grouped by expected keys', () => {
    expect(Object.keys(CODES)).toHaveLength(49);
    expect(Object.keys(CODES)).toEqual([
      'TEXT_EXACT_DUPLICATE_CROSS_ACCOUNT',
      'TEXT_NEAR_DUPLICATE',
      'TEXT_TEMPLATE',
      'TEXT_UNICODE_OBFUSCATION',
      'TEXT_GENERIC',
      'TEXT_NO_SPECIFICS',
      'TEXT_SENTIMENT_RATING_MISMATCH',
      'TEXT_PROMOTIONAL',
      'TEXT_LLM_STYLE',
      'TEXT_PROMPT_INJECTION',
      'BEH_NEW_ACCOUNT',
      'BEH_HIGH_VELOCITY',
      'BEH_RATING_DEVIATION',
      'BEH_RATING_ENTROPY',
      'BEH_FIVESTAR_PATTERN',
      'BEH_PRIOR_FLAGS',
      'BEH_CATEGORY_HOPPING',
      'BEH_UNVERIFIED',
      'TIME_PRODUCT_BURST',
      'TIME_LOW_INTERARRIVAL_CV',
      'TIME_IMPOSSIBLE_INTERVALS',
      'TIME_SYNC_POSTING',
      'TIME_REVIEW_AFTER_SIGNUP',
      'MEDIA_EXACT_REUSE',
      'MEDIA_NEAR_REUSE',
      'MEDIA_EXIF_STRIPPED',
      'MEDIA_EDIT_SOFTWARE',
      'MEDIA_TIME_MISMATCH',
      'MEDIA_SCREENSHOT',
      'NET_DEVICE_REUSE',
      'NET_SHARED_SUBNET',
      'NET_UA_HEADLESS',
      'NET_DATACENTER_ASN',
      'NET_LOCALE_MISMATCH',
      'RATING_EXCESS_FIVESTAR',
      'RATING_DISTRIBUTION_ANOMALY',
      'RATING_BIMODAL',
      'RATING_MEAN_SHIFT',
      'POLICY_INCENTIVE_LANGUAGE',
      'POLICY_CONTACT_INFO',
      'POLICY_CONDITIONAL_INCENTIVE',
      'POLICY_UNDISCLOSED_INSIDER',
      'POLICY_REVIEW_SUPPRESSION_OFFER',
      'POLICY_GATING_EVIDENCE',
      'POLICY_ENGAGEMENT_PURCHASE',
      'SAFETY_REVIEW',
      'GRAPH_CAMPAIGN',
      'SEM_PARAPHRASE_CLUSTER',
      'SEM_LLM_TEXT_LIKELIHOOD',
    ]);
  });

  it('exposes ALL_SIGNAL_CODES in registry order', () => {
    expect(ALL_SIGNAL_CODES).toEqual(Object.values(CODES));
    expect(ALL_SIGNAL_CODES).toHaveLength(49);
  });

  it('isSignalCode accepts every code and rejects unknowns', () => {
    expect(isSignalCode('SCREAMING_NOISE')).toBe(false);
    expect(isSignalCode('')).toBe(false);
    expect(isSignalCode('graph_campaign')).toBe(false);
    for (const code of ALL_SIGNAL_CODES) expect(isSignalCode(code)).toBe(true);
  });
});

describe('GENERIC_BASELINE', () => {
  it('is the J-shaped neutral rating baseline', () => {
    expect(GENERIC_BASELINE).toEqual([0.05, 0.05, 0.1, 0.2, 0.6]);
  });

  it('sums to one so it is a probability distribution', () => {
    const sum = GENERIC_BASELINE.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
  });
});

describe('SELECTION_EXCLUSION_REASONS (transparency contract — exclusions are never silent)', () => {
  it('maps stable reason strings', () => {
    expect(SELECTION_EXCLUSION_REASONS).toEqual({
      BELOW_MIN_TRUST: 'SELECTION_BELOW_MIN_TRUST',
      FLAGGED_DECISION: 'SELECTION_FLAGGED_DECISION',
      DUPLICATE_CLUSTER: 'SELECTION_DUPLICATE_CLUSTER',
      REPLACED_FOR_CRITICAL_COVERAGE: 'SELECTION_REPLACED_FOR_CRITICAL_COVERAGE',
      CAPACITY_LIMIT: 'SELECTION_CAPACITY_LIMIT',
    });
  });
});
