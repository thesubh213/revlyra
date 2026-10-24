# revlyra

Self-hosted review integrity engine with an embedded SDK, CLI, and Fastify API.

```bash
npm install revlyra
npx revlyra init
npx revlyra serve
```

```ts
import { createRevlyra } from 'revlyra';

const runtime = await createRevlyra();
const { result } = await runtime.service.ingest('default', {
  review: {
    itemId: 'p1',
    reviewerId: 'u1',
    rating: 5,
    text: 'Best product ever!!!',
    submittedAt: new Date().toISOString(),
  },
});

console.log(result.score, result.decision, result.reasons);
await runtime.close();
```

Features:
- SQLite (`node:sqlite`) and Postgres stores
- Files, SQLite, Postgres, MySQL, MongoDB, and REST sources (read-only)
- Media hashing (optional `sharp`), safe URL fetching, EXIF checks
- Background jobs: scan, bulk ingest, campaigns, integrity, retention
- Tenant API keys, scopes, admin API, signed webhooks, audit chain
- Ed25519 licenses, dev keys, online leases, entitlement gates
- CLI: init, keygen, keys, sources, scan, analyze, explain, report, select, serve,
  worker, db, audit, doctor, bench

Configuration: see the repository [.env.example](../../.env.example) and
[docs/API.md](../../docs/API.md).
