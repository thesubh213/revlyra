# @revlyra/sdk

Isomorphic HTTP client and webhook verifier for the Revlyra API.

```ts
import { createClient, verifyWebhook } from '@revlyra/sdk';

const client = createClient({
  baseUrl: 'http://127.0.0.1:8787',
  apiKey: process.env.REVLYRA_API_KEY!,
});

const analysis = await client.analyze({ review });
const integrity = await client.getItemIntegrity('drill-1');
const selection = await client.selectReviews('drill-1', { limit: 10, minTrust: 0.6 });

const valid = await verifyWebhook(rawBody, signatureHeader, webhookSecret);
```

Works in Node 18+, browsers, and edge runtimes (fetch + Web Crypto). POST requests
send idempotency keys; 429/5xx responses retry with exponential backoff;
`RevlyraApiError` carries `status`, `code`, and `requestId`.
