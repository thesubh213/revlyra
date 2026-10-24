# Examples

These snippets are intentionally dependency-light. They are not part of the
workspace build.

## Express middleware

```ts
import express from 'express';
import { createRevlyra } from 'revlyra';

const runtime = await createRevlyra(); // reads .env.local
const app = express();
app.use(express.json());

app.post('/reviews', async (request, response, next) => {
  try {
    const { result, review } = await runtime.service.ingest('default', {
      review: request.body,
      reviewer: { accountCreatedAt: request.body.accountCreatedAt },
      item: { category: request.body.category },
    });

    if (result.decision === 'hold' || result.decision === 'escalate') {
      return response.status(202).json({
        status: 'pending_review',
        reviewId: review.id,
        reasons: result.reasons.map((reason) => reason.code),
      });
    }

    response.json({ status: 'published', reviewId: review.id, label: result.decision });
  } catch (error) {
    next(error);
  }
});

process.on('SIGTERM', () => runtime.close());
```

## Next.js route handler

```ts
import { createClient } from '@revlyra/sdk';

const client = createClient({
  baseUrl: process.env.REVLYRA_URL!,
  apiKey: process.env.REVLYRA_API_KEY!,
});

export async function POST(request: Request) {
  const review = await request.json();
  const result = await client.analyze({ review });
  return Response.json({ decision: result.decision, reasons: result.reasons });
}
```

## Webhook receiver

```ts
import { verifyWebhook, parseWebhookEvent } from '@revlyra/sdk';

export async function POST(request: Request) {
  const raw = await request.text();
  const signature = request.headers.get('x-revlyra-signature') ?? '';
  const valid = await verifyWebhook(raw, signature, process.env.REVLYRA_WEBHOOK_SECRET!);
  if (!valid) return new Response('invalid signature', { status: 401 });

  const { event, data } = parseWebhookEvent(raw);
  if (event === 'review.flagged') {
    await enqueueHumanReview(data.reviewId);
  }
  return Response.json({ ok: true });
}
```

## Scan a Postgres source

```ts
import { createRevlyra } from 'revlyra';

const runtime = await createRevlyra();
const source = await runtime.store.createSource({
  tenantId: 'default',
  kind: 'postgres',
  name: 'reviews-read-replica',
  config: {
    urlRef: 'REVLYRA_SOURCE_PG_URL',
    table: 'public.reviews',
    where: "created_at > now() - interval '90 days'",
    batchSize: 500,
  },
  mapping: {
    fields: {
      itemId: 'product_id',
      reviewerId: 'user_id',
      rating: 'rating',
      text: 'body',
      submittedAt: 'created_at',
      verifiedPurchase: 'verified_purchase',
    },
  },
});

const job = await runtime.store.createJob({
  tenantId: 'default',
  kind: 'scan',
  payload: { sourceId: source.id, limit: 10000 },
});
console.log('queued', job.id);
await runtime.close();
```

Run `revlyra worker` to process the queued scan.
