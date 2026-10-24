import { CODES } from '../codes';
import {
  CONDITIONAL_INCENTIVE_PATTERNS,
  DISCLOSURE_PATTERNS,
  INCENTIVE_PATTERNS,
  INSIDER_SELF_ASSERT_PATTERNS,
  SUPPRESSION_THREAT_PATTERNS,
} from '../features/lexicons';
import type { Detector, DetectorContext, Signal } from '../types';
import { isEnabled, signal } from './helpers';

function hitPatterns(
  text: string,
  patterns: Array<{ code: string; re: RegExp }>,
): Array<{ code: string; re: RegExp }> {
  // Clone per call: shared global regexes carry lastIndex across reviews.
  return patterns.filter((pattern) => new RegExp(pattern.re.source, pattern.re.flags).test(text));
}

function run(ctx: DetectorContext): Signal[] {
  if (!isEnabled('policy', ctx.policy, 'policy')) return [];
  const signals: Signal[] = [];
  const text = ctx.normalized.text;
  let incentiveScore = 0;
  const matched: string[] = [];

  for (const pattern of INCENTIVE_PATTERNS) {
    if (new RegExp(pattern.re.source, pattern.re.flags).test(text)) {
      incentiveScore += pattern.weight;
      matched.push(pattern.code);
    }
  }
  incentiveScore = Math.min(1, incentiveScore);

  if (incentiveScore > 0) {
    signals.push(
      signal(
        CODES.POLICY_INCENTIVE_LANGUAGE,
        'policy',
        Math.min(0.7, 0.3 + incentiveScore * 0.4),
        0.7,
        'The review contains language suggesting an incentive, sponsorship, or review-gating request.',
        { patterns: matched },
      ),
    );
  }

  // FTC 16 CFR § 465.4 — sentiment-conditioned incentives.
  const conditional = hitPatterns(text, CONDITIONAL_INCENTIVE_PATTERNS);
  if (conditional.length > 0) {
    signals.push(
      signal(
        CODES.POLICY_CONDITIONAL_INCENTIVE,
        'policy',
        Math.min(0.75, 0.45 + 0.15 * conditional.length),
        0.7,
        'The text offers compensation conditioned on a rating direction, which is prohibited by 16 CFR § 465.4 regardless of disclosure.',
        { patterns: conditional.map((item) => item.code) },
      ),
    );
  }

  // FTC 16 CFR § 465.7 — coercive removal offers or groundless legal threats.
  const suppression = hitPatterns(text, SUPPRESSION_THREAT_PATTERNS);
  if (suppression.length > 0) {
    signals.push(
      signal(
        CODES.POLICY_REVIEW_SUPPRESSION_OFFER,
        'policy',
        Math.min(0.7, 0.4 + 0.15 * suppression.length),
        0.65,
        'The text appears to condition refunds or threaten legal action to coerce review edits or removal (16 CFR § 465.7).',
        { patterns: suppression.map((item) => item.code) },
      ),
    );
  }

  // FTC 16 CFR § 465.5 — insider relationship without clear disclosure.
  const relationship = ctx.review.reviewerRelationship ?? ctx.analysis.reviewer?.relationship;
  const isInsider = relationship !== undefined && relationship !== 'customer';
  const selfAssert = INSIDER_SELF_ASSERT_PATTERNS.some((pattern) =>
    new RegExp(pattern.re.source, pattern.re.flags).test(text),
  );
  const disclosed =
    DISCLOSURE_PATTERNS.some((pattern) =>
      new RegExp(pattern.re.source, pattern.re.flags).test(text),
    ) || (ctx.features['text.disclosure'] ?? 0) > 0;
  if (isInsider && !disclosed) {
    const severity = selfAssert ? 0.35 : 0.5;
    signals.push(
      signal(
        CODES.POLICY_UNDISCLOSED_INSIDER,
        'policy',
        severity,
        0.75,
        'A material reviewer relationship is declared by the source but no disclosure appears in the text (16 CFR § 465.5).',
        {
          relationship,
          selfAsserted: selfAssert,
          disclosurePresent: false,
        },
      ),
    );
  }

  // Gating workflow evidence and purchased-engagement flags come from caller
  // metadata; they are process evidence, not legal determinations.
  const gateFunnel = ctx.review.metadata?.gateFunnel === true;
  if (gateFunnel) {
    signals.push(
      signal(
        CODES.POLICY_GATING_EVIDENCE,
        'policy',
        0.3,
        0.9,
        'Caller metadata marks a pre-publication rating gate for this submission; compliance review may be required (not a legal determination).',
        { gateFunnel: true },
      ),
    );
  }

  const purchasedEngagement = ctx.review.metadata?.purchasedEngagement === true;
  if (purchasedEngagement) {
    signals.push(
      signal(
        CODES.POLICY_ENGAGEMENT_PURCHASE,
        'policy',
        0.45,
        0.8,
        'Caller metadata indicates bought social engagement associated with this review (16 CFR § 465.8).',
        { purchasedEngagement: true },
      ),
    );
  }

  const contactCount =
    ctx.normalized.stats.urlCount +
    ctx.normalized.stats.emailCount +
    ctx.normalized.stats.phoneCount;
  if (contactCount > 0) {
    signals.push(
      signal(
        CODES.POLICY_CONTACT_INFO,
        'policy',
        0.15,
        0.5,
        'The review contains contact details or outbound links.',
        {
          urls: ctx.normalized.stats.urlCount,
          emails: ctx.normalized.stats.emailCount,
          phones: ctx.normalized.stats.phoneCount,
        },
      ),
    );
  }

  return signals;
}

export const policyDetector: Detector = {
  id: 'policy',
  version: '1.1.0',
  families: ['policy'],
  run,
};
