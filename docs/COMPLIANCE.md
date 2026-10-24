# Compliance notes

This is engineering guidance, not legal advice. Review with counsel.

Revlyra implements the architectural reforms recommended by
"Online Review Ecosystem Challenges" (§ 5.1): transparent distributional
reporting, proof-tied weighting, prompt-injection defense for AI tiers,
DSA-style moderation due process, safety-warning isolation, and
pseudonymity-preserving identity minimization. The tables below map each
regulatory requirement to a concrete control.

## FTC Consumer Review Rule — 16 CFR Part 465

The Rule (effective October 21, 2024) allows civil penalties of $51,744 per
violation in 2024, rising to $53,088 per violation effective January 17, 2025
and fixed through 2026 under OMB M-26-11. Each individual fake or improperly
incentivized review is a separate violation — a 50-review campaign can expose
a business or its marketing agency to over $2.65m in statutory liability.
There is no private right of action; enforcement runs through FTC/DOJ
litigation (2025 warning letters; 2026 TruHeight, Premium Home Service, and
GovAssist actions).

| Rule section | Prohibited practice                                                                               | Revlyra control                                                                                                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| § 465.2      | Writing/buying/selling reviews by non-existent persons (explicitly covering AI-generated reviews) | duplicate and paraphrase detection (`TEXT_EXACT_DUPLICATE_CROSS_ACCOUNT`, `TEXT_NEAR_DUPLICATE`, `SEM_PARAPHRASE_CLUSTER`), LLM-style caps (`TEXT_LLM_STYLE` ≤ 0.35), prompt-injection sensing (`TEXT_PROMPT_INJECTION`) |
| § 465.4      | Sentiment-conditioned incentives, even disclosed                                                  | `POLICY_CONDITIONAL_INCENTIVE` (patterns: "gift card for a 5-star review", paid-review offers, refund-for-rating)                                                                                                        |
| § 465.5      | Insider reviews without clear, unavoidable disclosure                                             | `POLICY_UNDISCLOSED_INSIDER` driven by `CanonicalReview.reviewerRelationship` / `ReviewerProfile.relationship`; self-assertion and `#ad`/sponsored wording count as disclosure                                           |
| § 465.6      | Misrepresenting company-controlled review sites                                                   | covered by insider + promotional signals; document a dedicated source when the platform hosts its own review property                                                                                                    |
| § 465.7      | Groundless legal threats / intimidation / hiding negatives                                        | `POLICY_REVIEW_SUPPRESSION_OFFER`; no review-gating API; negative reviews can only be held/escalated with evidence, never deleted for sentiment                                                                          |
| § 465.8      | Bought social-media engagement indicators                                                         | `POLICY_ENGAGEMENT_PURCHASE` (caller metadata flag)                                                                                                                                                                      |

The rule holds agencies, PR firms, brokers, and reputation-management firms
liable alongside the sponsoring brand while exempting ordinary consumers and
mere hosting platforms — reason codes make the operating evidence shareable
for both upstream accountability and downstream audits.

Google additionally treats review gating and any incentive as a
Rating-Manipulation Policy violation with a four-stage sanction (strip
reviews, review lock, public warning banner, suspension). Revlyra exposes
`POLICY_GATING_EVIDENCE` (caller metadata `gateFunnel`) so gate funnels can be
watched even though the FTC rule itself does not ban gating.

Operational rules:
1. Never use Revlyra to route only happy customers to a public review site.
2. Never delete a negative review because it is negative; only for policy or
   integrity reasons with evidence.
3. Keep a human in the loop for removal and account restrictions.
4. Preserve the audit trail for the retention period; do not edit it.
5. Disclose incentives and material connections where required.
6. Do not use reviewer attributes protected by law as risk signals.

## EU — Digital Services Act (Regulation (EU) 2022/2065)

| DSA provision | Obligation                                                                                     | Revlyra surface                                                                                                                                                                                                   |
| ------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Art. 14       | Moderation terms & generic policy info in plain language                                       | reason codes + explanations; statements of reasons reference "operator terms", supplied by the hosting platform                                                                                                   |
| Art. 15 / 24  | Annual transparency reports (takedown volumes, complaint outcomes, automated tool usage)       | `GET /v1/admin/transparency` + `revlyra transparency` — decision histogram, top codes, appeal outcomes, SLA breaches, automation share, fairness groups                                                           |
| Art. 16       | Notice-and-action for illegal content                                                          | `POST /v1/notices` (complaint/legal/authority), status workflow, substantiated-notice flag, `notice.*` audit + webhook                                                                                            |
| Art. 17       | Statement of reasons for removals and visibility demotions                                     | `GET /v1/reviews/:id/statement-of-reasons` (`revlyra.sor/0.1` JSON or markdown) — grounds, facts, automation disclosure, redress path, evidence digest; demoting decisions are audit-logged (`review.sor_issued`) |
| Art. 20 / 21  | Timely internal complaints handled by qualified human staff, minus purely automated rejections | `POST /v1/appeals/:id/adjudication` requires a human `handlerHmac`; SLA promise time stored on open (`REVLYRA_APPEAL_SLA_DAYS`, default 30); breaches visible in the transparency report                          |
| Art. 53       | Out-of-court certified dispute bodies                                                          | `REVLYRA_OOCD_BODY` reference included in every statement of reasons                                                                                                                                              |

Silent "not-recommended" demotions are replaced by selector `exclusions`
lists (with `SELECTION_*` reasons) — no visibility change happens without an
explanable reason code.

## United Kingdom — DMCCA 2024 (Schedule 20 ¶13, CMA Guidance CMA208)

Publishers must take "reasonable and proportionate steps" to prevent, detect,
and remove banned reviews and misleading aggregate ratings. Revlyra's
proportionate-steps bundle is deterministic and documented:
1. Automated screening with calibrated signals (documented in DETECTORS.md).
2. Human-supervised holds and adjudicated appeals with SLA tracking.
3. Continuous re-screening via campaign jobs and reviewer history signals.
4. Monthly JSON/HTML transparency evidence exportable for the CMA's five
   2026 investigation focus areas (detection adequacy, verification,
   risk-assessment workflows).
5. Retention of audit records (`REVLYRA_AUDIT_DAYS`, default 2 years) with a
   tamper-evident hash chain (`revlyra audit verify`).

## Safety-review isolation (TripAdvisor case)

The report documents platforms deleting first-person crime/assault warnings
under "family-friendly" presentation rules. Revlyra's countermeasure is
default-on:
- Incident-first cues (assault, drugging, blackouts, armed robbery, hospitals,
  foodborne illness, fires, emergency services) trigger `SAFETY_REVIEW`.
- Routing floors the decision at `escalate` (human channel) and blocks
  auto-removal; the risk score is unaffected so reviewer history stays fair.
- Trauma prose styling (typos, caps, brevity) cannot be punished as
  genericness/bot style while routing is active (`styleSuppression` ×0.3).
- Every routed review is auditable (`safety_review.routed`) and webhooked
  (`safety.escalated`) so emergency sweeps never sit in spam queues.

## Pseudonymity and identity (Glassdoor case)

Retroactive linking of real-world identity to anonymous accounts without
explicit granular consent breaks FTC Act unfairness baselines and GDPR
transparency rules. Revlyra:
- stores reviewer/item/actor identifiers as tenant-scoped HMACs; raw IPs are
  used transiently and never persisted;
- strips identity-shaped keys (names, resumes, profile URLs, DOB/SSN-shaped
  keys) from caller metadata before persistence
  (`REVLYRA_IDENTITY_MINIMIZATION`, default on; allocations are audited as
  `review.identity_keys_stripped`);
- never enriches reviewer profiles with third-party identity sources; the
  platform contract forbids submitting them in the first place.

## GDPR / UK GDPR

See [PRIVACY.md](PRIVACY.md). Key points:
- Legitimate-interest assessment + DPIA for large-scale profiling.
- Transparency notice and appeal path (see the DSA table; Art. 22 of the GDPR
  aligns with DSA Art. 20/21 human supervision).
- Data minimization and retention (HMACs, no raw IPs, `purgeOlderThan`).
- DPA and processor terms.

## AI Act (EU)

Content moderation and fraud detection are generally not high-risk under
Annex III, but transparency and human oversight obligations may apply
depending on the deployment. Keep model documentation (model card + versioned
fusion artifacts), appeal records, and the statement-of-reasons trail. Legal
review is required for each jurisdiction.

## Fairness and consumer protection

- Monitor false-positive rates by language, review length, account age, and
  region: the transparency report includes flagged-share and overturn-share
  by language and review-length band.
- Do not label a review "fake" publicly; use cautious language and reason codes.
- Appeal overturn rates above ~5% on a code should trigger an
  `REVLYRA_POLICY` weight/threshold review (see TUNING.md).
- Distributional stats (`allPositiveSuspicion`, `polarizationIndex`) are
  published as context — never as fraud determinations.
- Document the limitations of device/network signals (NAT, shared networks,
  privacy proxies): a subnet-only campaign ring requires temporal cohesion to
  fire and is scored with reduced weight.

## Record keeping

Keep for each adverse decision (all present by default):
- Review and item identifiers (HMACs)
- Score, band, decision, confidence
- Reason codes and signal contributions (with redacted evidence)
- Model and policy versions
- Statement-of-reasons digest + issuance audit entries
- Human reviewer identity (HMAC) and timestamp; appeal SLA + outcome
- Notice receipts and status transitions

`revlyra audit export` produces JSONL for this purpose.
