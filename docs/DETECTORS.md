# Detector catalog

Every detector returns evidence. Fusion decides. Reason codes are stable across
releases; messages may change.

## Content

### Duplicate content (`duplicate`, weight 2.8)

| Code                                 | Trigger                                                 | Severity   | Notes                                  |
| ------------------------------------ | ------------------------------------------------------- | ---------- | -------------------------------------- |
| `TEXT_EXACT_DUPLICATE_CROSS_ACCOUNT` | SHA-256 of normalized text matches another account      | 0.98, hard | Strongest single signal                |
| `TEXT_NEAR_DUPLICATE`                | SimHash Hamming ≤ 3 or MinHash similarity ≥ 0.78        | 0.5–0.95   | Cross-account only                     |
| `TEXT_TEMPLATE`                      | 5-gram coverage ≥ 25% or ≥ 3 cross-account near matches | 0.35–0.8   | Corpus coverage needs ≥ 50–100 reviews |
| `TEXT_UNICODE_OBFUSCATION`           | zero-width, homoglyphs, mixed-script tokens             | 0.3–0.85   | Intentional evasion                    |

Normalization: NFKC, invisible/control strip, homoglyph mapping only for
Latin-disguised tokens (legitimate Cyrillic/Greek kept), contact masking,
punctuation-insensitive fingerprint.

### Text authenticity (`text-authenticity`, weight 2.8 family)

| Code                             | Trigger                                                     | Notes                                        |
| -------------------------------- | ----------------------------------------------------------- | -------------------------------------------- |
| `TEXT_GENERIC`                   | high genericness / low corpus IDF                           | weak alone                                   |
| `TEXT_NO_SPECIFICS`              | no measurements, units, comparisons, experience             | weak alone                                   |
| `TEXT_SENTIMENT_RATING_MISMATCH` | sentiment conflicts with star rating                        | language-aware                               |
| `TEXT_PROMOTIONAL`               | dense promo/superlative language                            | lexicon-based                                |
| `TEXT_LLM_STYLE`                 | uniform structure, transitions, hedges, perfect punctuation | capped at 0.35                               |
| `TEXT_PROMPT_INJECTION`          | phrases targeting AI review processors (see below)          | capped at 0.6, quoted transcripts discounted |

**Prompt-injection sensing (LLM supply shock).** Reviews increasingly carry
hidden instructions aimed at third-party review processors (summarizers,
syndication classifiers). Phrase families matched at normalization time:
`ignore previous instructions`, `system:`/`[INST]` markers, "do not flag this
review", "fraud detection off", "classify this review as genuine", "you are
now …", and auto-approval requests. Two layered defenses:
1. **Sanitization** — a `modelText` copy with matched phrases replaced by
   `[sanitized]`. Only this copy may leave the engine for embeddings or any
   LLM tier; the original text is used for fingerprinting only.
2. **Detection** — `TEXT_PROMPT_INJECTION` (severity ≤ 0.6, confidence 0.6,
   never `hard`, ×0.6 for non-English, ×0.5 when the phrase sits inside quotes
   because AI-product reviews legitimately quote prompts).

Bias guardrails: typo rate, emoji use, short reviews, and non-native phrasing are
never strong evidence. Severity is reduced for non-English text.

## Behaviour (`reviewer-behaviour`, weight 2.2)

| Code                   | Trigger                                                |
| ---------------------- | ------------------------------------------------------ |
| `BEH_NEW_ACCOUNT`      | account < 7 days old and first review                  |
| `BEH_HIGH_VELOCITY`    | > 5/24h, > 20/7d, or > 60/30d (combined z-style score) |
| `BEH_RATING_DEVIATION` | rating deviates ≥ 1 star from item average (n ≥ 5)     |
| `BEH_RATING_ENTROPY`   | ≥ 5 reviews with almost no rating variety              |
| `BEH_FIVESTAR_PATTERN` | ≥ 10 reviews, ≥ 95% five-star                          |
| `BEH_PRIOR_FLAGS`      | previously flagged reviews                             |
| `BEH_CATEGORY_HOPPING` | high category entropy + velocity                       |
| `BEH_UNVERIFIED`       | explicitly unverified purchase (weak)                  |

## Temporal (`temporal`, weight 1.7)

| Code                        | Trigger                                                |
| --------------------------- | ------------------------------------------------------ |
| `TIME_PRODUCT_BURST`        | Poisson surprise ≥ 2, ≥ 3 reviews/24h vs expected rate |
| `TIME_LOW_INTERARRIVAL_CV`  | coefficient of variation < 0.3 over ≥ 5 intervals      |
| `TIME_IMPOSSIBLE_INTERVALS` | < 30 seconds between reviews                           |
| `TIME_SYNC_POSTING`         | ≥ 3 reviews within 10 minutes                          |
| `TIME_REVIEW_AFTER_SIGNUP`  | review within 1 hour of signup                         |

Poisson tail uses the exact PMF for λ ≤ 30 and a normal approximation above.
Burst requires an item baseline (`expectedReviewsPerDay`); otherwise it is silent.

## Media (`media`, weight 2.4) — optional `sharp`

| Code                  | Trigger                                                |
| --------------------- | ------------------------------------------------------ |
| `MEDIA_EXACT_REUSE`   | identical image bytes in another account/review (hard) |
| `MEDIA_NEAR_REUSE`    | pHash Hamming ≤ 12                                     |
| `MEDIA_EXIF_STRIPPED` | no camera Make/Model (weak; platforms strip)           |
| `MEDIA_EDIT_SOFTWARE` | Photoshop/Lightroom/Canva/etc.                         |
| `MEDIA_TIME_MISMATCH` | captured date inconsistent with review date            |
| `MEDIA_SCREENSHOT`    | screenshot-like dimensions/aspect                      |

Hashes: SHA-256, dHash-64, pHash-64 (32×32 DCT, 8×8 low frequencies), 4×16-bit
band indexes. Media processing is asynchronous; the decision is `provisional`
until hashes exist.

## Network (`network`, weight 0.7)

| Code                  | Trigger                           | Notes                    |
| --------------------- | --------------------------------- | ------------------------ |
| `NET_DEVICE_REUSE`    | same device ID across accounts    | strongest network signal |
| `NET_SHARED_SUBNET`   | many accounts from one /24 or /48 | weak; NAT/shared egress  |
| `NET_UA_HEADLESS`     | headless/automation UA            | weak                     |
| `NET_DATACENTER_ASN`  | datacenter origin                 | weak                     |
| `NET_LOCALE_MISMATCH` | locale vs language mismatch       | weak                     |

Network signals never create a campaign alone. Raw IPs are not persisted; only
HMACs, country/ASN, and truncated subnets.

## Rating (`rating`, weight 1.1)

Only runs with **n ≥ 30** ratings.

| Code                          | Trigger                                   |
| ----------------------------- | ----------------------------------------- |
| `RATING_EXCESS_FIVESTAR`      | observed five-star share exceeds baseline |
| `RATING_DISTRIBUTION_ANOMALY` | chi-square vs baseline ≥ 7.78 (p < 0.1)   |
| `RATING_BIMODAL`              | bimodality coefficient ≥ 0.6              |
| `RATING_MEAN_SHIFT`           | mean shift vs baseline                    |

## Policy (`policy`, weight 0.9)

| Code                              | Trigger                                                              | Notes                                |
| --------------------------------- | -------------------------------------------------------------------- | ------------------------------------ |
| `POLICY_INCENTIVE_LANGUAGE`       | free product, gift card, sponsored, five-star request, gating phrase | FTC workflows support                |
| `POLICY_CONTACT_INFO`             | URL/email/phone in review                                            |                                      |
| `POLICY_CONDITIONAL_INCENTIVE`    | compensation conditioned on a rating direction (§ 465.4)             | e.g. "gift card for a 5-star review" |
| `POLICY_UNDISCLOSED_INSIDER`      | declared reviewer relationship with no disclosure in text (§ 465.5)  | needs `reviewerRelationship`         |
| `POLICY_REVIEW_SUPPRESSION_OFFER` | refunds/threats/token rewards to coerce edits or removals (§ 465.7)  |                                      |
| `POLICY_GATING_EVIDENCE`          | caller metadata `gateFunnel` marks a pre-publication rating gate     | evidence only                        |
| `POLICY_ENGAGEMENT_PURCHASE`      | caller metadata `purchasedEngagement` (bought followers/likes)       | evidence only (§ 465.8)              |

These support FTC compliance workflows; they are not legal determinations.

## Safety routing (`safety`, policy family, weight 0.9)

| Code            | Trigger                                                                                                                                                                     | Notes                              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `SAFETY_REVIEW` | incident-first cues: assault, drugging/blackout, armed robbery, hospital/medical injury, foodborne illness, fire/electrical hazard, emergency-service contact, water rescue | routed to the human safety channel |

Routing rules (pipeline, not score-based):
- Minimum decision = `escalate` (human safety channel) — never `remove`, never
  silently `downrank`. This is the TripAdvisor guardrail (§2.2 of the
  challenges report).
- Style suppression: when an incident is detected, presentation-style signals
  (`TEXT_GENERIC`, `TEXT_NO_SPECIFICS`, `TEXT_LLM_STYLE`,
  `TEXT_SENTIMENT_RATING_MISMATCH`) drop to ×0.3 so trauma prose is not
  punished as genericness or bot prose.
- The signal lives in the low-weight policy family so the reviewer's stored
  risk score stays fair; the decision override is exposed as `result.safety`.

## Graph (`graph`, weight 2.1)

| Code             | Trigger                                     |
| ---------------- | ------------------------------------------- |
| `GRAPH_CAMPAIGN` | reviewer belongs to a confirmed dense block |

Campaign job (heterogeneous graph mimic of CARE-GNN/GraphConsis):
1. Candidate edges from the last 180 days (co-review links within 48 h).
2. **Heterogeneous edges** — reviewers are additionally linked when they share
   an attribute group within the window: identical normalized template
   (`same_template`), identical media hash (`same_media`), HMAC'd device ID
   (`same_device`), truncated subnet (`same_subnet`). Group keys are
   pseudonymous hashes; groups need ≥ 2 distinct reviewers (capped at 30).
3. Union-find + weighted label propagation. A pair unions when either the
   co-review weight (≥ 1.2) or ≥ 2 corroborating group kinds apply.
4. FRAUDAR-style greedy peel with column weight `1/log(degree + 5)`.
5. Campaign gating: require ≥ 3 reviewers, ≥ 2 signal families, temporal
   cohesion (or ≥ 2 edge kinds), and density above the baseline. A single
   subnet/device ring with no cohesion cannot form a campaign — NAT and shared
   housing are protected ("do not punish shared networks").
6. Scoring includes edge-kind diversity up to +0.1; `confirmed` → policy
   action; removal requires a human.

## Semantic (`semantic`, content family) — optional

| Code                      | Trigger                           |
| ------------------------- | --------------------------------- |
| `SEM_PARAPHRASE_CLUSTER`  | embedding cosine ≥ 0.86           |
| `SEM_LLM_TEXT_LIKELIHOOD` | classifier ≥ 0.8 (capped at 0.35) |

Models are downloaded only with explicit consent and are checksum-cached.

## Reason code contribution

```
contribution = familyWeight × severity × confidence
```

`reasons` are sorted by contribution. The API returns all reasons plus the top
signals; the CLI prints the top six.

## Trust-weighted rating (integrity) and selection

The selector and integrity scorer implement the distributional-transparency
recommendations of the challenges report (§ 1, § 5.1):
- **Recency decay** — trust weights decay by `exp(−ageDays / halfLifeDays)`;
  default half-life 120 days (90 for `marketplace`/`travel`, 150 for
  `local-business`, 200 for `lenient`). Tunable via
  `policy.integrity.recencyHalfLifeDays`; `0` disables.
- **Verification weighting** — verified purchases ×`verifiedBoost` (default
  1.15) and explicitly unverified ×`unverifiedFactor` (default 0.9).
- **Distribution signals** — alongside the adjusted rating, integrity reports
  `stdDev`, `modeStars`, `positiveRatio`, `criticalShare`, `polarizationIndex`
  (J-shape indicator), `allPositiveSuspicion` (flags 100%-positive profiles;
  a transparency statistic, not a fraud score), `verifiedShare`,
  `recencyWeightedShare90d`, `medianAgeDays`.
- **Rare-event inclusion** — the selector guarantees one representative per
  present 1–3-star bucket so buyers sampling a few reviews cannot underweight
  defects (description–experience gap).
- **Exclusions are never silent** — every dropped/demoted review is returned
  with a `SELECTION_*` reason (`SELECTION_BELOW_MIN_TRUST`,
  `SELECTION_FLAGGED_DECISION`, `SELECTION_DUPLICATE_CLUSTER`,
  `SELECTION_REPLACED_FOR_CRITICAL_COVERAGE`, `SELECTION_CAPACITY_LIMIT`).

## Research basis

- Jindal & Liu, _Opinion Spam and Analysis_ (2008)
- Ott et al., _Finding Deceptive Opinion Spam_ (2011)
- Mukherjee et al., _What Yelp Fake Review Filter Might Be Doing_ (2013)
- Fei et al., _Exploiting Burstiness in Reviews_ (2013)
- Wang et al., _Review Graph Based Online Store Review Spammer Detection_ (2011)
- Hooi et al., _FRAUDAR: Bounding Graph Fraud in the Face of Camouflage_ (KDD 2016)
- Hu, Pavlou & Zhang, _Why Do Online Product Reviews Have a J-Shaped Distribution?_ (2009/2013) — basis for the distributional-transparency block and the all-positive-suspicion statistic
- _A Survey on Fake Review Detection: From PLMs to LLMs_ (2026)
- CARE-GNN / GraphConsis-style heterogeneous-graph fraud detection — design intent behind the multi-kind campaign edges
- Bhandari et al., _Real-Time Detection of Fake Reviews Using Behavioral Patterns_ (2026)
- FTC, _16 CFR Part 465_ (Consumer Reviews and Testimonials Rule) — § 465.2/465.4/465.5/465.7/465.8 policy signals
- EU DSA Articles 14–21 and 53 — statement-of-reasons, notice-and-action, and human-supervised appeals surface
- UK DMCCA 2024 Schedule 20 ¶13 + CMA Guidance CMA208 — publisher duties reflected in the transparency report
- Mixpeek, _Perceptual Hashing for Near-Duplicate Detection_
- Sift, _Velocity Detection_
- YelpCHI dataset; Salminen et al. fake reviews dataset
