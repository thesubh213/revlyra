# @revlyra/transformer

Optional local semantic tier for Revlyra: embeddings for paraphrase clustering and
a pluggable text-classification model.

```bash
pnpm add @revlyra/transformer @huggingface/transformers
```

```ts
import { createTransformer } from '@revlyra/transformer';

const tier = createTransformer({
  modelDir: '/var/cache/revlyra/models',
  allowDownload: true, // explicit consent
  embeddingModel: 'Xenova/all-MiniLM-L6-v2',
  classifierModel: 'your-org/deberta-fake-review', // optional
});

const hints = await tier.analyze(reviewText, neighbors);
```

Safety:
- Models are not downloaded unless `allowDownload: true`.
- `offline: true` forbids remote model resolution.
- Runs locally; no review text leaves the host.
- Model quality and calibration are the customer's responsibility unless a model
  card says otherwise. Treat LLM-text likelihood as weak evidence.
