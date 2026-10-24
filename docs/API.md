# HTTP API

Base URL: `http://127.0.0.1:8787/v1`
- JSON only.
- Tenant auth: `Authorization: Bearer rvlyra_live_<prefix>_<secret>`.
- Admin auth: `Authorization: Bearer <REVLYRA_ADMIN_KEY>` plus optional
  `X-Revlyra-Tenant` for multi-tenant admin operations.
- Errors:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed.",
    "request_id": "req-1",
    "details": [{ "path": "review.rating", "message": "..." }]
  }
}
```

Stable error codes include `AUTH_MISSING`, `AUTH_INVALID_KEY`,
`SCOPE_FORBIDDEN`, `ADMIN_REQUIRED`, `LICENSE_INVALID`, `FEATURE_NOT_ENTITLED`,
`LIMIT_EXCEEDED`, `VALIDATION_ERROR`, `REVIEW_NOT_FOUND`, `ITEM_NOT_FOUND`,
`CAMPAIGN_NOT_FOUND`, `SOURCE_NOT_FOUND`, `JOB_NOT_FOUND`, `RATE_LIMITED`.

## Endpoints

### `POST /reviews/analyze`

```json
{
  "review": {
    "id": "optional-external-id",
    "itemId": "drill-1",
    "reviewerId": "user-1",
    "rating": 5,
    "text": "Best product ever!!! Works perfectly.",
    "submittedAt": "2026-10-24T10:00:00Z",
    "verifiedPurchase": false,
    "media": [{ "url": "https://example.com/photo.jpg" }],
    "context": {
      "ip": "203.0.113.10",
      "userAgent": "Mozilla/5.0",
      "locale": "en-US",
      "timezone": "America/Los_Angeles"
    }
  },
  "reviewer": {
    "accountCreatedAt": "2026-10-24T09:55:00Z",
    "sharedDeviceCount": 4,
    "priorFlags": 0
  },
  "item": {
    "category": "tools",
    "stats": { "baselineDistribution": [0.05, 0.07, 0.13, 0.3, 0.45] }
  },
  "sourceId": "api"
}
```

Response: `AnalysisResult` plus `reviewId` and optional `mediaWarnings`.

Key fields: `score`, `band`, `decision`, `confidence`, `dataCompleteness`,
`signals[]`, `reasons[]`, `familyScores`, `modelVersion`, `policyVersion`,
`provisional`, `timings`.

The same review text from a different reviewer on the same item returns
`TEXT_EXACT_DUPLICATE_CROSS_ACCOUNT` and a score ≥ 0.9.

### `POST /reviews/batch`

Body: `{ reviews: Review[], reviewer?, item?, sourceId? }`, max
`REVLYRA_LIMIT_MAX_BATCH` (default 1000). Returns per-item success/error summaries.

### `POST /ingest/reviews`

Same body as batch. Above 50 reviews it returns `202 { jobId }`; poll
`GET /jobs/:id`. At or below 50 it processes synchronously and returns counts.

### `GET /reviews/:id`

Returns stored summary + result. Add `?includeText=1` to include normalized text
(tenant-scoped).

### `GET /reviews/:id/explain`

Returns decision, score, reasons, signals, and model/policy versions.

### `POST /feedback`

```json
{
  "reviewId": "…",
  "label": "genuine",
  "reasonCode": "verified_purchase_context",
  "notes": "Optional internal note"
}
```

Labels: `genuine`, `fake`, `unsure`, `policy_violation`. Feedback is stored for
calibration and audit; it does not silently retrain a live model.

### Appeals

- `POST /appeals` `{ reviewId, reason? }`
- `GET /appeals?status=open|upheld|overturned`

Appeals are the human-review path required for adverse decisions.

### `GET /reviewers/:id/risk`

Accepts an internal reviewer ID or the external ID. Returns stored reviewer risk,
the latest snapshot, and aggregates (counts, rating distribution, recent timing).

### `GET /items/:id/integrity`

Accepts an internal item ID or external ID. Returns raw/adjusted rating, delta,
confidence interval, effective sample size, suspicion rate, excess five-star,
chi-square, bimodality, distribution, and top concerns.

### `POST /items/:id/select`

```json
{
  "limit": 10,
  "minTrust": 0.6,
  "diversify": true,
  "includeFlagged": false,
  "lambda": 0.75
}
```

Returns selected reviews with `trustScore`, `selectionReason`, cluster IDs,
aspect coverage, and exclusions.

### Campaigns

- `GET /campaigns?limit=100`
- `GET /campaigns/:id`

### `POST /scan`

```json
{ "sourceId": "…", "limit": 10000, "sync": false }
```

Creates a scan job; `sync: true` runs it inline. Requires `scan:write`.

### `GET /jobs/:id`

Returns job status, attempts, result, error, and timestamps.

### `GET /usage`

Returns the current month’s review count, limit, entitlements, and usage counters.

### `GET /health`, `GET /version`

Public. Health includes license status.

## Admin

Require the admin key.

| Method | Path                     | Purpose                                       |
| ------ | ------------------------ | --------------------------------------------- |
| POST   | `/admin/keys`            | Create tenant API key (raw key returned once) |
| GET    | `/admin/keys`            | List keys (hashes never returned)             |
| POST   | `/admin/keys/:id/revoke` | Revoke a key                                  |
| POST   | `/admin/sources`         | Register a source                             |
| GET    | `/admin/sources`         | List sources                                  |
| DELETE | `/admin/sources/:id`     | Remove a source                               |
| GET    | `/admin/audit`           | List audit entries                            |
| GET    | `/admin/audit/verify`    | Verify the hash chain                         |
| GET    | `/admin/license`         | Entitlements and limits                       |
| POST   | `/admin/campaigns/run`   | Queue campaign detection                      |
| POST   | `/admin/retention`       | Queue a retention purge                       |

## Webhooks

Configure `REVLYRA_WEBHOOK_URL` and `REVLYRA_WEBHOOK_SECRET`.

Headers:

```
X-Revlyra-Event: review.flagged
X-Revlyra-Signature: t=1700000000,v1=<hex hmac>
```

Signature = HMAC-SHA256(secret, `${timestamp}.${rawBody}`). Verify with
`verifyWebhook()` from `@revlyra/sdk` (300-second tolerance). Events currently
include `review.flagged`, `review.feedback`, `ingest.queued`, `scan.queued`.

## Rate limits and sizes

- Global per-IP limit: `REVLYRA_LIMIT_RPS` (default 50/s).
- Body limit: 1 MB default, configurable.
- Text: 20,000 characters after validation.
- Media URL: 10 MB, image content types only, 3 redirects, 10-second timeout.

## SDK

```ts
import { createClient, verifyWebhook } from '@revlyra/sdk';

const client = createClient({
  baseUrl: 'http://127.0.0.1:8787',
  apiKey: process.env.REVLYRA_API_KEY!,
});

const result = await client.analyze({ review });
const integrity = await client.getItemIntegrity('drill-1');
const selection = await client.selectReviews('drill-1', { limit: 10, minTrust: 0.6 });
```

The SDK retries 429/5xx with backoff, sends idempotency keys on POST, and exposes
`RevlyraApiError`.
