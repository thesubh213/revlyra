# @revlyra/core

Runtime-neutral review integrity engine. No `node:` imports, no native
dependencies.

```ts
import { analyzeReview, getPolicyPreset, selectReviews, computeIntegrity } from '@revlyra/core';

const result = analyzeReview(
  {
    id: 'r1',
    itemId: 'p1',
    reviewerId: 'u1',
    rating: 5,
    text: 'Best product ever!!! Works perfectly.',
    submittedAt: '2026-10-24T10:00:00Z',
  },
  {
    reviewer: { totalReviews: 2, reviewsLast24h: 8, accountCreatedAt: '2026-10-24T09:00:00Z' },
    textMatches: [{ reviewId: 'r0', reviewerId: 'u2', itemId: 'p1', similarity: 1, kind: 'exact' }],
  },
  { policy: getPolicyPreset('balanced') },
);

console.log(result.score, result.decision, result.reasons);
```

Includes:
- Unicode normalization, homoglyph mapping, contact masking, language detection
- SHA-256, FNV-1a, SimHash-64, MinHash/LSH
- Content, behaviour, temporal, network, media, rating, policy, graph, semantic detectors
- Calibrated logistic fusion, decisions, reason codes
- Review selector with near-duplicate clustering and diversity
- Trust-weighted item integrity
- Co-review graph detection with label propagation and a FRAUDAR-inspired peel

Model and policy artifacts are versioned JSON. The baseline model is
`src/model/baseline.json`.

See the repository [README](../../README.md) and [DETECTORS.md](../../docs/DETECTORS.md).
