# Honest limitations

Revlyra is a risk-scoring system, not a fraud oracle. These limits are deliberate
and should be reflected in your UI, policies, and appeals process.

## Evaluation limits

The bundled synthetic evaluation (`pnpm eval`) reports perfect precision/recall on
its own injected attacks. That corpus is intentionally easy: attacks share text,
timing, media hashes, or network context. It validates the plumbing and regression
behavior, not real-world accuracy. Measure on your own reviewer-disjoint labels.

## Detection limits

- **Paraphrased campaigns** with fresh accounts, original photos, and distributed
  devices can pass every detector. Embeddings help; they do not solve it.
- **AI-generated text** detection is probabilistic and degrades as models improve.
  LLM-style signals are capped and never decisive.
- **Prompt injection** detection is a lexicon, not an LLM. Determined attackers
  paraphrase ("kindly disregard", split across sentences); the guardrails cover
  common operator phrasing only, and quoted transcripts in AI-product reviews
  are deliberately discounted (severity ×0.5, capped 0.6, never `hard`).
- **Safety lexicon misses and false trips**: incident-first English patterns
  ("assaulted", "blacked out", "gas smell") catch common phrasing, but a review
  reporting danger in other words will not route, and unusual phrasing can
  trip a route in error. Routing costs attention, not the review: nothing is
  removed automatically.
- **Residential proxies and human farms** defeat device/IP correlation. Network
  signals are low-weight corroboration.
- **Short reviews** are hard: little text, unstable SimHash, few behavioral cues.
- **New tenants** lack baselines; confidence is explicitly lower.
- **Popular items** naturally attract bursts and co-reviewers; campaign detection
  requires multiple signal families and temporal cohesion.
- **Images** can be re-encoded, cropped, rotated, or mirrored to evade pHash.
  Semantic image embeddings are future work.
- **Language coverage** is strongest for English; non-English severity is reduced,
  and lexicons are limited.

## Weighting and statistics limits

- **Recency half-life** (default 120 days) is a policy parameter informed by
  consumer surveys (74% disregard reviews older than ~3 months), not a truth
  about product durability; long-lived products may warrant `0` (off).
- **Verified-purchase weighting** (+15%/−10%) proxies reliability; verification
  badges can be forged off-platform (the broker-ring case in the report), so
  the boost is deliberately ordered below graph and duplicate evidence.
- **`polarizationIndex` / `allPositiveSuspicion`** describe distributions; a
  naturally excellent 5-star item lands in the same range as an inflated one.
  They are published context, never fraud scores, and the 96% consumer-suspicion
  figure behind them describes buyer psychology, not detection.
- **The description–experience guarantee** relies on rating inputs being
  honest; a flood of shipped 1★ attacks will occupy the guaranteed slots.

## Network/device limits

- NAT, carrier-grade NAT, corporate egress, VPNs, and shared housing make IP/subnet
  signals noisy.
- Browser fingerprinting is often < 50% unique and degrades with privacy tools.
- A blocked or rotated device ID is not proof of fraud.
- Revlyra never stores raw IPs; this limits some forensic follow-up by design.

## Operational limits

- SQLite is single-node; use Postgres for multiple API/worker instances.
- Media hashing requires optional `sharp`; without it, media signals are absent
  and the decision is provisional.
- The semantic tier requires explicit model download consent and local compute.
- The reference license server is not a hardened multi-region control plane.
- License checks in client-side code can be patched; online leases and contracts
  are the practical enforcement.

## Legal/ethical limits

- Revlyra does not determine whether a review is legally “fake.”
- Adverse decisions can have significant effects; use human review and appeals.
- Do not use protected attributes or proxies for them.
- Do not use Revlyra to gate or suppress legitimate negative reviews.
- Compliance depends on the customer's policies, notices, and jurisdiction.

## What “high confidence” means

A 0.95 score means the calibrated model considers the observed pattern highly
unusual given the available data. It does **not** mean there is a 95% chance the
reviewer is a paid fraudster. Calibration is dataset- and tenant-dependent; measure
it on your own labels.
