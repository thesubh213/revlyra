# Architecture

## Goals

1. High-precision detection of copy-paste campaigns, coordinated bursts, sockpuppets, image reuse, and rating manipulation.
2. Explainable decisions that a support agent or compliance reviewer can defend.
3. Safe operation inside a customer's infrastructure against read-only data.
4. Portable core logic that can later run beyond Node.

## Pipeline

```
CanonicalReview
  │
  ├─ validate/canonicalize (zod, size caps, prototype-pollution guard)
  ├─ normalize (NFKC, invisible chars, homoglyphs, contact masking)
  ├─ injection screening (pattern lexicon → modelText sanitizer + stats)
  ├─ fingerprint (SHA-256 exact, SimHash-64, MinHash bands)
  ├─ enrich (reviewer/item aggregates, corpus, text/media matches, campaign hint)
  ├─ features (content, behaviour, temporal, network, media, rating, safety)
  ├─ detectors (independent, versioned, emit signals)
  ├─ fusion (family aggregation → logistic → isotonic calibration)
  ├─ decision (policy thresholds → allow/label/downrank/hold/escalate/remove)
  ├─ safety routing (SAFETY_REVIEW ⇒ decision floor escalate, autoRemove blocked)
  └─ explain (top contributions, reason codes, confidence, statement of reasons)
```

### Signal contract

```ts
interface Signal {
  code: string; // stable reason code
  family:
    | 'content'
    | 'behaviour'
    | 'temporal'
    | 'media'
    | 'network'
    | 'graph'
    | 'rating'
    | 'policy';
  severity: number; // 0..1
  confidence: number; // 0..1 reliability of the evidence
  hard?: boolean; // exact cross-account duplicate / shared image
  evidence: Record<string, unknown>; // redacted
  explanation: string;
}
```

Detectors never make the final decision. This keeps rules independently testable
and lets the fusion model be replaced without rewriting detection logic.

### Fusion

Within a family:

```
familyScore = max(severity × confidence)
            + 0.15 × min(1, corroboratingSignals / 3)
            (capped at 1)
```

Across families:

```
logit(p) = policy.intercept
         + Σ policy.familyWeights[family] × familyScore[family]
         + policy.modelWeight × logit(calibratedModelScore)
```

- `p` is clamped to 0.999.
- A hard flag raises `p` to at least `hardFlagFloor` (0.82 by default) but never
  auto-removes without policy opt-in and confidence.
- Isotonic calibration knots live in the model artifact.
- Confidence is a function of data completeness, signal confidence, family
  diversity, and model calibration quality.

### Decisions

| p                  | Decision | Default action                                    |
| ------------------ | -------- | ------------------------------------------------- |
| 0.00–0.29          | allow    | publish                                           |
| 0.30–0.54          | label    | publish with transparency label                   |
| 0.55–0.74          | downrank | lower rank, exclude from adjusted rating          |
| 0.75–0.89          | hold     | human review                                      |
| 0.90–1.00          | escalate | hold + campaign/account investigation             |
| ≥ remove threshold | remove   | only with `autoRemove` and confidence ≥ threshold |

Safety override (doc 2.2/5.1, default-on): a review carrying `SAFETY_REVIEW`
is floored at `escalate` and `remove` is bypassed regardless of score, so
public-safety warnings always reach a human channel.

Presets: `balanced`, `strict`, `lenient`, `marketplace`, `local-business`,
`app-store`, `travel`. Each preset also carries document-derived defaults:
- `policy.safety = { enabled: true, styleSuppression: true }` — routing and
  style-suppression switches;
- `policy.integrity = { recencyHalfLifeDays, verifiedBoost,
  unverifiedFactor, ensureCritical }` — 120/90/150-day half-lives per preset,
  +15%/−10% verification weighting, and the critical-review guarantee.

## Runtime-neutral core

`@revlyra/core` uses only standard language/runtime APIs:
- `Intl.Segmenter` for word/sentence segmentation
- pure-TS SHA-256, FNV-1a, SimHash, MinHash
- no `node:` imports, no filesystem, no database

The Node package owns OS concerns: SQLite/Postgres, source adapters, media,
jobs, Fastify, licensing, CLI.

## Stores

`Store` has two implementations:
- **SQLite** via `node:sqlite` (default; zero native dependency)
- **Postgres** via `pg` (production/multi-instance)

Both use the same logical schema:

| Area         | Tables                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------- |
| Tenancy/auth | `tenants`, `api_keys`                                                                                   |
| Sources/jobs | `sources`, `jobs`                                                                                       |
| Reviews      | `reviews`, `review_signals`, `reviewers`, `items`, `reviewer_item_edges`                                |
| Fingerprints | `text_index`, `text_bands`, `media`, `media_bands`                                                      |
| Coordination | `campaigns`, `campaign_members`                                                                         |
| Governance   | `feedback`, `appeals` (SLA/handler columns), `notices`, `audit_log`, `usage_counters`, `risk_snapshots` |

Schema bumps are additive forward-only migrations recorded in
`schema_migrations` (`002_dsa_review_integrity` adds the appeals SLA/handler
columns; SQLite uses a `PRAGMA table_info` guard, Postgres uses
`ADD COLUMN IF NOT EXISTS`).

Key indexes cover tenant/time, reviewer, item, status, exact text hash, fingerprint
bands, media hashes, and graph edges.

### Audit chain

Each audit row stores `prev_hash` and `hash = SHA-256(prev_hash + canonical_json)`.
`revlyra audit verify` walks the chain and reports the first broken sequence.

## Sources

```
ReviewSource {
  capabilities: { incremental, reviewerHistory, media, context }
  test(): SourceTestResult
  pull(options): AsyncIterable<SourceReview>
}
```

- Files: JSON array (streamed), NDJSON, CSV.
- SQLite: read-only connection, `PRAGMA query_only`.
- Postgres/MySQL: read-only transaction, statement timeout, batched keyset/offset.
- MongoDB: `secondaryPreferred`, projection, `maxTimeMS`.
- REST: paginated GET, SSRF-safe URL validation, cursor/page/offset modes.

Credentials are environment references, never raw database rows. Custom SQL is
limited to a single `SELECT`/`WITH` statement.

## Jobs

Persisted queue with attempts, backoff, claimed timestamps, and dead letters.

Handlers:
- `scan` — pull a source and ingest reviews
- `bulk_ingest` — process a pushed batch
- `campaigns` — build reviewer/item edges plus heterogeneous same-template,
  same-media, same-device, same-subnet group edges, then detect dense blocks
- `integrity` — recompute item risk snapshots
- `retention` — purge expired reviews, signals, media, and fingerprints

SQLite uses a transactional `UPDATE … RETURNING`; Postgres uses
`FOR UPDATE SKIP LOCKED`.

## Review selector

1. Drop `hold`/`remove`/`escalate` unless explicitly included.
2. Cluster near-duplicates (fingerprints + token Jaccard for short reviews).
3. Score: `trust^1.2 × helpfulness^0.5 × recency^0.3 × specificity^0.4`.
4. MMR diversification (`λ = 0.75`), aspect coverage bonus.
5. **Critical guarantee** (`ensureCritical`, default on): at least one
   representative per present 1–3-star bucket so buyers sampling few reviews
   cannot underweight defects (description–experience gap). Displaced reviews
   are never removed silently — see `exclusions` with `SELECTION_*` reasons
   (below min trust, flagged decision, duplicate cluster, replaced for
   critical coverage, capacity limit).

## Item integrity

```
adjusted = (C·m + Σ trust_i · rating_i) / (C + Σ trust_i)
```

- `C = 10`, `m` = category/baseline prior (fallback 4.2, reflecting the ~4.42
  global mean documented in the report)
- Trust weight per review:
  `clamp(trust) × decisionWeight × exp(−ageDays / recencyHalfLifeDays) × verifiedFactor`
  (recency default half-life 120 days; verified +1.15 / unverified ×0.9)
- Effective sample size `(Σw)² / Σw²`
- Weighted variance → 95% interval + weighted `stdDev`
- Suspicion rate, excess five-star, chi-square, bimodality, mean shift
- **Distributional transparency block** (doc §1, §5.1): `modeStars`,
  `positiveRatio`, `criticalShare`, `polarizationIndex` (J-shape),
  `allPositiveSuspicion` (zero critical reviews in ≥ 20; a context statistic,
  never a fraud score), `verifiedShare`, `recencyWeightedShare90d`,
  `medianAgeDays`.
- Downranked reviews get 0.25 weight; held/removed get 0.

## Statement of reasons (DSA Art. 17)

Derived deterministically from stored signals for any decision:
`revlyra.sor/0.1` JSON (or markdown) carries decision + visibility wording,
per-family grounds, automation disclosure, redress path (internal complaint
with SLA days, optional out-of-court body, regulator hint), calibration
limitations, and a SHA-256 evidence digest. Demoting decisions are audited
(`review.sor_issued`) when served.

## Transparency & fairness reporting (DSA Art. 15/24; DMCCA)

`buildTransparencyReport` aggregates review-window decisions, top codes,
appeal outcomes (overturn rate, median resolution days, SLA breaches),
notices, automation share, and fairness groups (flag/overturn share by
language and review-length band). Available as admin JSON/HTML and via the
CLI.

## Licensing

- **Dev key:** `rvlyra_dev_…`, local hash registration, 30 days, evaluation features.
- **Signed license:** `rvlyra_lic_v1_<payload>.<sig>`, Ed25519, offline verification.
- **Lease:** `rvlyra_lease_v1_…`, 24 hours, install-bound, online revocation.
- **Tenant API keys:** `rvlyra_live_<prefix>_<secret>`, SHA-256 stored, scopes,
  expiry, rotation, revocation.

See [SECURITY.md](SECURITY.md) for the threat model.
