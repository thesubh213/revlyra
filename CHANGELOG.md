# Changelog

## 0.2.0 — unreleased

Aligned with the architectural reforms in "Online Review Ecosystem Challenges"
(docs/Online Review Ecosystem Challenges.md): distributional transparency,
LLM supply-shock defenses, safety-review isolation, DSA-style due process, and
FTC §465 / DMCCA compliance surfaces.

### @revlyra/core

- **Reason-code registry** (`src/codes.ts`): every signal code centralized;
  shared `SELECTION_*` exclusion reasons.
- **Prompt-injection defense** (report §3.2): `TEXT_PROMPT_INJECTION` (capped
  0.6, quote-discounted) plus a `modelText` sanitizer that neutralizes
  operator-phrases before any semantic/LLM tier consumes review text.
- **Safety-review routing** (report §2.2/§5.1): `SAFETY_REVIEW` from
  incident-first cues floors decisions at `escalate` (human channel), blocks
  auto-removal, and suppresses style signals (×0.3) so trauma prose is not
  punished; `result.safety` carries the routed categories. Score is unaffected.
- **FTC §465 policy signals**: `POLICY_CONDITIONAL_INCENTIVE` (§465.4),
  `POLICY_UNDISCLOSED_INSIDER` (§465.5, driven by
  `CanonicalReview.reviewerRelationship`), `POLICY_REVIEW_SUPPRESSION_OFFER`
  (§465.7), `POLICY_GATING_EVIDENCE`, `POLICY_ENGAGEMENT_PURCHASE` (§465.8).
- **Heterogeneous campaign graph** (CARE-GNN direction): same-template,
  same-media, same-device, and same-subnet group edges with edge-kind
  diversity in campaign scoring; single-kind rings require temporal cohesion
  so NAT/shared networks stay unpunished.
- **Trust-weighted rating v1.1** (report §1/§5.1): recency decay
  (`recencyHalfLifeDays` default 120), verified-purchase weighting
  (+1.15/×0.9), weighted std-dev, and a `distributionSignals` block
  (mode, polarization, `allPositiveSuspicion`, verified share, 90-day recent
  weight, median age). The J-shaped-distribution finding (Hu–Pavlou–Zhang) is
  surfaced instead of the bare mean.
- **Selector**: `ensureCritical` guarantees one 1–3★ representative per
  present bucket (description–experience gap) and every dropped review is
  listed in `exclusions` with a stable reason.
- `BEH_PRIOR_FLAGS` now consumes overturned-appeal history (previously dead).
- Policy v1.1.0 with `safety`/`integrity` sections in all presets.

### revlyra (platform)

- **Statement of reasons** (DSA Art. 17): `revlyra.sor/0.1` JSON/markdown via
  `GET /v1/reviews/:id/statement-of-reasons` and `revlyra
  statement-of-reasons`; issuance audited with an evidence digest.
- **Appeals** (DSA Art. 20): `POST /v1/appeals/:id/adjudication` with a
  required human handler identity, SLA promise (`REVLYRA_APPEAL_SLA_DAYS`),
  outcome notes, webhook `appeal.resolved`, and reviewer history updates.
- **Notices** (DSA Art. 16): `notices` table + CRUD routes +
  `notice.received`/status workflow for complaint/legal/authority filings.
- **Transparency & fairness report** (DSA Art. 15/24; DMCCA proportionate
  steps): `GET /v1/admin/transparency` and `revlyra transparency` with
  decision histograms, appeal overturn rates, SLA breaches, automation share,
  notices, and fairness groups (flag/overturn share by language and length).
- **Identity-key scrubbing** (Glassdoor guardrail): identity-shaped metadata
  keys stripped pre-persistence under default-on
  `REVLYRA_IDENTITY_MINIMIZATION`, audited per strip.
- Campaigns job feeds the heterogeneous edges from reviews/media tables.
- API keys: prefixes are now underscore-free (fixes a `extractApiKeyPrefix`
  ambiguity flake).
- Webhooks: `safety.escalated`, `appeal.resolved`, `notice.received`.

### @revlyra/sdk

- `getStatementOfReasons`, `adjudicateAppeal`, `createNotice`, `listNotices`,
  and admin `transparencyReport`.

### Tooling & docs

- Eval corpus extended with prompt-injection, conditional-incentive,
  suppression-offer, insider, and safety-clean cases; `pnpm eval` now asserts
  expected reason codes per class and that routed safety reviews are never
  auto-removed (threshold gate unchanged: recall ≥ .85, F1 ≥ .85, FPR ≤ 3%).
- Docs: DETECTORS (new code tables), ARCHITECTURE (pipeline, selector,
  integrity, SoR, transparency), COMPLIANCE (per-regulation control mapping),
  PRIVACY (identity scrubbing + notice/appeal retention), SECURITY and
  THREAT-MODEL (injection adversary), LIMITATIONS (weighting/statistics
  caveats), TUNING (document-driven knobs).
- 97 tests (was 59) covering the new detectors, routing, selector guarantee,
  migration guard, store governance methods, DSA HTTP surface, and SDK
  methods.

## 0.1.0 — unreleased

Initial implementation.
- `@revlyra/core`: normalized pipeline, fingerprints, ten detector families,
  calibrated fusion, reasons, selector, integrity, campaign graph.
- `revlyra`: SQLite/Postgres stores, six source adapters, media hashing, jobs,
  Fastify API, CLI, tenant API keys, licenses/leases, signed webhooks, audit chain.
- `@revlyra/sdk`: isomorphic client and webhook verification.
- `@revlyra/transformer`: optional local embeddings/classifier tier.
- `@revlyra/license-server`: reference Ed25519 license and lease control plane.
- 59 unit/integration tests; CLI, API, source scan, and license lease smoke-tested
  end to end.
- Synthetic evaluation harness (`pnpm eval`) with exact/near duplicate, campaign,
  burst, media-reuse, and rating-bomb attacks.
