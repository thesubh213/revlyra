# Source adapters

All adapters are **read-only** and yield a canonical review plus optional reviewer
and item hints. Credentials are referenced by environment variable name, never
stored raw in the database.

```ts
interface ReviewSource {
  capabilities: { incremental; reviewerHistory; media; context };
  test(): Promise<SourceTestResult>;
  pull(options?): AsyncIterable<SourceReview>;
  close?(): Promise<void>;
}
```

## Field mapping

Register a source with a `mapping`. If omitted, common field names are
auto-detected.

```json
{
  "fields": {
    "externalId": "review.id",
    "itemId": "product.sku",
    "reviewerId": "author.id",
    "rating": { "path": "review.stars", "transform": "number" },
    "text": "review.body",
    "submittedAt": { "path": "created_at", "transform": "date" },
    "verifiedPurchase": "verified",
    "language": "lang",
    "media": "photos"
  },
  "reviewerFields": {
    "accountCreatedAt": "author.joined_at",
    "stats": "author.stats"
  },
  "itemFields": {
    "category": "product.category",
    "attributes": "product.attributes",
    "stats": "product.stats"
  },
  "mediaFields": {
    "url": "url",
    "sha256": "meta.hash"
  }
}
```

Transforms: `string`, `number`, `boolean`, `date` (epoch seconds/ms or ISO),
`json`. Dot paths and `[0]` indexes are supported.

Auto-detected names include `item_id`/`product_id`, `reviewer_id`/`user_id`,
`rating`/`stars`, `text`/`review`/`content`, and
`created_at`/`submitted_at`/`date`.

## Files

```json
{ "path": "./reviews.json", "format": "json" }
```

- `json`: streamed array
- `ndjson` / `jsonl`: one object per line
- `csv`: header row, `delimiter` configurable

```bash
revlyra source add --kind files --name demo --file ./reviews.json --format json
```

## SQLite

```json
{
  "path": "./reviews.db",
  "table": "reviews",
  "where": "created_at > '2025-01-01'",
  "limit": 100000
}
```

Opened with `readOnly: true` and `PRAGMA query_only = ON`. Custom `query` must be
a single `SELECT`/`WITH`; multiple statements are rejected.

## Postgres

```json
{
  "urlRef": "REVLYRA_SOURCE_PG_URL",
  "table": "public.reviews",
  "where": "created_at > now() - interval '90 days'",
  "batchSize": 500
}
```

Every batch runs inside `BEGIN READ ONLY`, with `statement_timeout = 30s`.
Credentials should belong to a read-only role and preferably a replica.

## MySQL / MariaDB

```json
{
  "urlRef": "REVLYRA_SOURCE_MYSQL_URL",
  "query": "SELECT * FROM reviews WHERE deleted_at IS NULL"
}
```

Uses `START TRANSACTION READ ONLY` and `MAX_EXECUTION_TIME`. For MariaDB, use a
read-only replica/replica user; the execution-time variable may be ignored on
older versions.

## MongoDB

```json
{
  "urlRef": "REVLYRA_SOURCE_MONGO_URL",
  "database": "shop",
  "collection": "reviews",
  "filter": { "status": "published" },
  "projection": { "text": 1, "rating": 1, "product_id": 1, "user_id": 1, "created_at": 1 },
  "limit": 100000,
  "batchSize": 500
}
```

`secondaryPreferred`, `maxTimeMS: 30000`, and an explicit projection. The adapter
never writes.

## REST

```json
{
  "url": "https://api.example.com/reviews",
  "auth": { "type": "bearer", "tokenRef": "REVIEWS_API_TOKEN" },
  "pagination": {
    "mode": "cursor",
    "cursorParam": "cursor",
    "nextField": "next_cursor",
    "limitParam": "limit",
    "pageSize": 100
  },
  "itemsPath": "data.items",
  "mapping": {
    "fields": {
      "itemId": "product_id",
      "reviewerId": "user_id",
      "rating": "rating",
      "text": "body",
      "submittedAt": "created_at"
    }
  }
}
```

- HTTPS required (HTTP only for localhost).
- Private/link-local/datacenter hosts blocked by default; redirects are
  revalidated, capped at 3, and each response is size-limited.
- Pagination modes: `cursor`, `page`, `offset`, `none`.
- Auth types: `bearer`, `basic`, `header`.

## Incremental sync

The source cursor is stored with the last successful `lastSubmittedAt`. Files and
simple table sources are re-read; use a `where`/`query` window for scale. One
source failing does not block others.

## Safety checks

```bash
revlyra source test <id>                  # map a sample, no writes
revlyra scan --source <id> --limit 100    # bounded first run
```

Before production:
1. Use a read-only database user.
2. Prefer a replica.
3. Set `--limit` and a query time window.
4. Confirm the mapping never selects unnecessary PII columns.
