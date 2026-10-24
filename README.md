# Revlyra

[![CI](https://github.com/thesubh213/revlyra/actions/workflows/ci.yml/badge.svg)](https://github.com/thesubh213/revlyra/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%E2%89%A522.13-339933)
[![Contributing](https://img.shields.io/badge/contributing-guide-8A2BE2)](CONTRIBUTING.md)

**A self-hosted review integrity engine.** Score reviews for manipulation risk, explain every decision, select the most trustworthy reviews for display, and compute a trust-weighted rating. Runs inside your infrastructure, reads your review databases read-only, and keeps the evidence auditable.

> Revlyra produces calibrated risk signals, not proof that a review is fake. No detector catches every coordinated campaign. See [docs/LIMITATIONS.md](docs/LIMITATIONS.md).

---

## What it does

- **Detects copy-paste campaigns** with Unicode normalization, exact hashes, SimHash/MinHash, and template detection.
- **Catches reviewer behavior** anomalies: velocity, rating deviation, rating entropy, five-star lockstep, category hopping.
- **Detects LLM supply-shock attacks**: prompt-injection phrases aimed at AI review processors are sensed, capped, and sanitized before any model tier sees the text.
- **Routes public-safety warnings to humans**: incident-first detection (assault, drugging, foodborne illness, fires) escalates to a human channel, never auto-removes, and stops style filters from punishing trauma prose.
- **Maps coordination networks** with multi-kind heterogeneous graphs (co-review, shared template/media/device/subnet), label propagation, and a FRAUDAR-inspired dense-block job — without punishing NAT.
- **Scores network/device signals** carefully (shared subnet/device, datacenter ASN, headless UA) without punishing NAT or shared networks.
- **Explains decisions** with stable reason codes, contributions, confidence, DSA-style statements of reasons, and model/policy versions.
- **Compliance surfaces for FTC 16 CFR §465 / EU DSA / UK DMCCA**: conditional-incentive, insider, suppression-threat signals, notices, human-adjudicated appeals with SLA, and an aggregate transparency + fairness report.
- **Publishes distributions, not just means**: trust-weighted rating with recency + verified-purchase weighting, plus std-dev, mode, polarization, and all-positive-suspicion stats.
- **Selects reviews** with trust weighting, near-duplicate collapsing, aspect coverage, MMR diversity, and a guaranteed critical-review slot — every exclusion carries a stated reason.
- **Protects pseudonymity**: identity-shaped metadata is scrubbed before persistence, and hosts must never re-link anonymous accounts retroactively.
- **Supports feedback and appeals** with a tamper-evident audit chain and human-in-the-loop removal.

## What it is not

- Not a scraper or review collection platform.
- Not a browser extension.
- Not a moderation UI (v1).
- Not a truth oracle or a replacement for human review.
- Not a tool for review gating or suppressing legitimate negative reviews.

---

## Quickstart

Requirements: **Node.js 22.13+ or 24 LTS**, npm/pnpm.

```bash
npm install revlyra
npx revlyra init
npx revlyra serve
```

`init` creates:
- `.env.local` with a 30-day dev license, HMAC pepper, admin key, and tenant API key
- `.revlyra/config.json`
- `.revlyra/revlyra.db` (SQLite by default)
- an audit-logged tenant API key (printed once)

Analyze a review from the CLI:

```bash
npx revlyra analyze \
  --text "The 12mm chuck holds bits securely and the battery lasted about four hours." \
  --rating 4 --item drill-1 --reviewer user-1
```

Or call the API:

```bash
curl -X POST http://127.0.0.1:8787/v1/reviews/analyze \
  -H "Authorization: Bearer $REVLYRA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "review": {
      "itemId": "drill-1",
      "reviewerId": "user-1",
      "rating": 5,
      "text": "Best product ever!!! Works perfectly and the quality is amazing.",
      "submittedAt": "2026-10-24T10:00:00Z"
    }
  }'
```

```json
{
  "reviewId": "…",
  "score": 0.72,
  "band": "high",
  "decision": "hold",
  "confidence": 0.68,
  "reasons": [
    { "code": "TEXT_EXACT_DUPLICATE_CROSS_ACCOUNT", "contribution": 2.6 },
    { "code": "TEXT_PROMOTIONAL", "contribution": 1.0 }
  ]
}
```

Full guides:
- [Architecture](docs/ARCHITECTURE.md)
- [Detector catalog and reason codes](docs/DETECTORS.md)
- [HTTP API](docs/API.md)
- [Source adapters](docs/ADAPTERS.md)
- [Security and threat model](docs/SECURITY.md)
- [Privacy](docs/PRIVACY.md)
- [Compliance](docs/COMPLIANCE.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Tuning](docs/TUNING.md)
- [Honest limitations](docs/LIMITATIONS.md)

---

## Packages

| Package                   | Purpose                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `revlyra`                 | Node runtime: store, sources, media, jobs, Fastify server, CLI                           |
| `@revlyra/core`           | Runtime-neutral engine: normalization, fingerprints, detectors, scoring, selector, graph |
| `@revlyra/sdk`            | Isomorphic HTTP client + webhook signature verification                                  |
| `@revlyra/transformer`    | Optional local embeddings/classifier tier (transformers.js/ONNX)                         |
| `@revlyra/license-server` | Reference vendor control plane for signed licenses and leases                            |

The core package has no `node:` imports and can be bundled for edge/serverless later.

---

## Architecture

```
review → normalize → fingerprint → features → detectors → calibrated fusion
      → decision + reasons → store → selector / integrity / campaigns
```

- **Tier 1:** pure TypeScript, no model download, ~15 ms p50 for text + behaviour.
- **Tier 2 (optional):** local embeddings for paraphrase clustering and a text classifier. Explicit download consent, checksum/cache, offline mode, graceful fallback.
- **Store:** SQLite (`node:sqlite`, zero native dependency) or Postgres.
- **Sources:** files, SQLite, Postgres, MySQL/MariaDB, MongoDB, REST — read-only.
- **Jobs:** scans, media enrichment, campaign detection, integrity snapshots, retention.

---

## CLI

```bash
revlyra init                     # setup
revlyra keygen --write-env       # new 30-day dev license
revlyra key create --tenant acme # tenant API key (shown once)
revlyra source add --kind files --file reviews.json
revlyra source test <id>
revlyra scan --source <id>
revlyra analyze --text "..." --rating 5
revlyra explain <review-id>
revlyra statement-of-reasons <review-id>   # DSA Art. 17 artifact
revlyra report --item <id> --html --out report.html
revlyra select --item <id> --limit 10
revlyra campaigns detect
revlyra campaigns list
revlyra appeals list                       # DSA Art. 20 workflows
revlyra appeals resolve <id> --outcome overturned --handler staffer-42
revlyra notices add --review <id> --type complaint --claim "..."
revlyra transparency --html --out report.html   # DSA Art. 15/24 + DMCCA evidence
revlyra serve
revlyra worker
revlyra doctor
revlyra bench
revlyra audit verify
```

All commands support `--json`.

---

## Configuration

| Variable                          | Purpose                                       | Default                 |
| --------------------------------- | --------------------------------------------- | ----------------------- |
| `REVLYRA_LICENSE_KEY`             | Dev or signed production license              | required                |
| `REVLYRA_LICENSE_PUBLIC_KEY`      | Ed25519 public key for signed licenses/leases | unset                   |
| `REVLYRA_LICENSE_SERVER`          | Online lease/revocation endpoint              | unset                   |
| `REVLYRA_PII_PEPPER`              | HMAC pepper for identifiers                   | generated               |
| `REVLYRA_ADMIN_KEY`               | Admin API key                                 | generated               |
| `REVLYRA_API_KEY`                 | First tenant API key                          | generated               |
| `REVLYRA_DB_DRIVER`               | `sqlite` or `postgres`                        | `sqlite`                |
| `REVLYRA_DB_PATH`                 | SQLite path                                   | `./.revlyra/revlyra.db` |
| `REVLYRA_DATABASE_URL`            | Postgres URL                                  | unset                   |
| `REVLYRA_HOST` / `REVLYRA_PORT`   | Server bind                                   | `127.0.0.1` / `8787`    |
| `REVLYRA_WORKER`                  | `inline`, `worker`, `off`                     | `inline`                |
| `REVLYRA_MEDIA_ENABLED`           | Enable image hashing                          | `false`                 |
| `REVLYRA_TRANSFORMER`             | Enable semantic tier                          | `false`                 |
| `REVLYRA_MODEL_DOWNLOAD`          | Consent to download models                    | `0`                     |
| `REVLYRA_RETENTION_DAYS`          | Review text retention                         | `180`                   |
| `REVLYRA_POLICY`                  | Preset or policy file                         | `balanced`              |
| `REVLYRA_WEBHOOK_URL` / `_SECRET` | Signed outbound webhooks                      | unset                   |
| `REVLYRA_APPEAL_SLA_DAYS`         | Appeal response promise (DSA Art. 20)         | `30`                    |
| `REVLYRA_SOR_TERRITORY`           | Statement-of-reasons locality                 | `global`                |
| `REVLYRA_IDENTITY_MINIMIZATION`   | Scrub identity-shaped metadata keys           | `1`                     |

See [.env.example](.env.example).

---

## Security and privacy

- API keys are stored only as SHA-256 hashes; raw keys are shown once.
- Reviewer/item identifiers are tenant-scoped HMACs; raw IPs are not persisted.
- Source adapters run in read-only transactions and never write back.
- Media URLs are SSRF-checked, redirect-revalidated, size-capped, and time-limited.
  Webhook targets are admin-configured and restricted to HTTPS (or localhost).
- License checks use Ed25519 signatures; online leases support revocation and a 7-day offline grace.
- Decisions and configuration changes are written to a tamper-evident audit chain.
- No telemetry by default.

Read [SECURITY.md](docs/SECURITY.md) and [PRIVACY.md](docs/PRIVACY.md).

---

## Development

```bash
corepack enable
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm --filter revlyra exec revlyra doctor
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for ground rules (reason-code stability,
privacy invariants, safety-routing invariants) and [SECURITY.md](SECURITY.md)
for private vulnerability reporting.

End-to-end demo:

```bash
mkdir demo && cd demo
node ../packages/revlyra/dist/cli/index.js init
node ../packages/revlyra/dist/cli/index.js serve
```

---

## License

Source-available for development and evaluation; final redistribution terms are
pending (FSL-1.1-ALv2 is the recommended candidate). Commercial use requires a
license. See [LICENSE](LICENSE).

---

## Research basis

Revlyra's detector design draws on the fake-review detection literature:
Yelp's behavioural filter, burstiness/co-bursting, FRAUDAR dense-block
detection, review graphs, psycholinguistic deception features, perceptual
hashing, and the FTC's Consumer Review Rule. The distributional-transparency,
safety-routing, and due-process surfaces follow the structural findings in
the "Architecture of Digital Trust" report (J-shaped distributions,
recency pressure, LLM supply shock, off-platform broker economics, and the
2024–2026 regulatory wave). The full reading list is in
[docs/DETECTORS.md](docs/DETECTORS.md#research-basis) and the deeper regulatory
mapping in [docs/COMPLIANCE.md](docs/COMPLIANCE.md).
