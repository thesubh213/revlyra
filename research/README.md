# Research and evaluation

This directory contains offline evaluation tooling. It is not shipped in the npm
packages.

## Synthetic evaluation

```bash
pnpm build   # core dist is required
pnpm eval
pnpm eval:json
```

`research/synthetic/generator.mjs` builds a deterministic corpus with:
- exact duplicate pairs across accounts
- near-duplicate pairs
- a 5-account × 3-item campaign with synchronized timing
- a 35-review/24h burst against a 1/day baseline
- reused images across accounts
- a 10-review five-star rating bomb against a 50-review baseline
- 200 clean reviews with established reviewers

`research/eval/run.mjs` reports precision, recall, F1, false-positive rate,
ROC-AUC, PR-AUC, and per-attack recall. The gate requires recall ≥ 0.85,
F1 ≥ 0.85, and FPR ≤ 3% at score ≥ 0.75.

**These numbers are synthetic.** The attacks are deliberately detectable and
share fingerprints/timing/network context. Do not present them as real-world
accuracy. For real evaluation, use reviewer-disjoint splits from YelpCHI, Ott et
al., Salminen et al., and your own labeled data; see
[docs/DETECTORS.md](../docs/DETECTORS.md#research-basis).

## Adding an attack

1. Add a generator function returning `{ review, context, fake, attack }`.
2. Keep originals clean (normal reviewer history) so false positives measure the
   detector, not the fixture.
3. Add the attack to `generateSyntheticCorpus`.
4. Tighten the gate only after measuring on real labels.
