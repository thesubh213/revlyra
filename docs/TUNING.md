# Tuning

## Policy presets

| Preset           | Intent                                    |
| ---------------- | ----------------------------------------- |
| `balanced`       | Default; conservative auto-actions        |
| `strict`         | Higher recall; lower thresholds           |
| `lenient`        | Fewer labels; higher thresholds           |
| `marketplace`    | Product listings; media/rating weights up |
| `local-business` | Service reviews; behaviour and policy up  |
| `app-store`      | Software listings                         |
| `travel`         | Hospitality; media and temporal up        |

Choose with `REVLYRA_POLICY=strict` or a JSON file path.

## Custom policy

```json
{
  "id": "acme-marketplace",
  "version": "2026.10.1",
  "familyWeights": {
    "content": 3.0,
    "behaviour": 2.2,
    "temporal": 1.8,
    "media": 2.7,
    "network": 0.5,
    "graph": 2.4,
    "rating": 1.3,
    "policy": 1.0
  },
  "modelWeight": 1.1,
  "intercept": -3.3,
  "thresholds": {
    "label": 0.3,
    "downrank": 0.55,
    "hold": 0.75,
    "remove": 0.95,
    "escalate": 0.85
  },
  "hardFlagFloor": 0.82,
  "minConfidenceForRemove": 0.6,
  "autoRemove": false,
  "safety": { "enabled": true, "styleSuppression": true },
  "integrity": {
    "recencyHalfLifeDays": 120,
    "verifiedBoost": 1.15,
    "unverifiedFactor": 0.9,
    "ensureCritical": true
  },
  "disabledDetectors": [],
  "disabledFamilies": []
}
```

Document-driven knobs (all default-on; disable flags for cautious tenants):

| Knob                            | Effect                                                                                 | Disable / adjust                        |
| ------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------- |
| `safety.enabled`                | `SAFETY_REVIEW` floors the decision at `escalate`, blocks `remove`                     | set `false` to opt out                  |
| `safety.styleSuppression`       | Drops style-signal severities ×0.3 on safety-routed reviews                            | set `false` to keep style scoring       |
| `integrity.recencyHalfLifeDays` | Trust-weight decay for adjusted rating (120 default; 90 travel/marketplace, 150 local) | `0` disables decay                      |
| `integrity.verifiedBoost`       | Trust multiplier for verified purchases (default 1.15)                                 | set `1` to flatten                      |
| `integrity.unverifiedFactor`    | Trust multiplier for explicitly unverified (default 0.9)                               | set `1` to flatten                      |
| `integrity.ensureCritical`      | Selector guarantees one 1–3★ representative; exclusions stay explainable               | set `false` for raw score order         |
| `REVLYRA_IDENTITY_MINIMIZATION` | Scrubs identity-shaped metadata keys before persistence (default 1)                    | `0` — only with explicit legal sign-off |
| `REVLYRA_APPEAL_SLA_DAYS`       | Stored appeal response promise (default 30) — DSA Art. 20                              | adjust to your ops capacity             |

Shadow-mode tip: the decision overrides (`safety`) act on routed category, not
score, so enable them before scoring-level calibration is tuned.

`REVLYRA_POLICY=./policy.json`.

## Threshold guidance

- Start with `balanced`, `autoRemove: false`, and `hold` for anything ≥ 0.75.
- Raise `label`/`downrank` if your reviewers see too many false positives.
- Lower `hold` only after measuring appeal/overturn rates.
- Keep `remove` ≥ 0.95 and require confidence ≥ 0.6.
- Do not auto-remove on a single signal; hard flags still require corroboration
  for removal.
- For marketplaces with known copy-paste attacks, raise `content` and `media`.
- For service businesses, raise `behaviour`/`temporal`; lower `network`.

## Model artifact

```json
{
  "version": "2026.10.1",
  "featureSpecVersion": "1.0.0",
  "intercept": -3.05,
  "weights": { "text.exactDup": 3.2, "beh.velocity": 1.2, "...": 0 },
  "calibration": { "kind": "identity" },
  "metrics": { "calibrationStatus": 1 }
}
```

Set `REVLYRA_MODEL_PATH=./model.json`. Retrain offline (logistic regression or a
distilled classifier), export coefficients, and validate on reviewer-disjoint
splits. Do not fit on unverified feedback.

## Feedback loop

1. Collect `genuine`/`fake` labels through `POST /feedback`.
2. Review appeals weekly; overturns > 5% for a reason code indicate a problem.
   The transparency report (`revlyra transparency`) surfaces overturn share
   per language and review-length band; route rate by safety category is
   observable through audits.
3. Re-run evaluation on a held-out, reviewer-disjoint set.
4. Adjust one thing at a time: a detector weight, a family weight, or a threshold.
5. Version the policy/model and record the change in the audit log.

## Shadow mode

Before acting on decisions:
- Run Revlyra in parallel with your current process.
- Store scores/decisions but do not publish labels or hold reviews.
- Compare flag rates and inspect a random sample of each reason code.
- Measure precision on a human-labeled sample and calibrate thresholds.

The API does not require you to act on a decision; `allow`/`label` can be ignored
while you evaluate.

## Bias checks

- Compute flag rates by language, review length, account age, and region.
- Cap linguistic penalties for non-native English and short reviews.
- Inspect false positives involving new accounts and shared networks.
- Document known failure modes in your DPIA.

## Rate and cost limits

- `REVLYRA_LIMIT_REVIEWS_PER_MONTH` caps monthly volume.
- `REVLYRA_LIMIT_RPS` caps request rate.
- Media hashing is CPU-bound; limit images per review and run a separate worker.
- Semantic models are optional and add latency; keep concurrency low.

## Performance

Run `revlyra bench --count 5000`. Investigate if p95 > 40 ms for text + behaviour.
Bottlenecks are usually text indexing or media hashing, not the detectors.
