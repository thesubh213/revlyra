# Deployment

## Docker

```bash
docker build -t revlyra .
docker run --rm -p 8787:8787 \
  -v revlyra-data:/data \
  -e REVLYRA_LICENSE_KEY="rvlyra_dev_..." \
  -e REVLYRA_PII_PEPPER="..." \
  -e REVLYRA_ADMIN_KEY="..." \
  -e REVLYRA_DB_PATH="/data/revlyra.db" \
  revlyra
```

The image uses `node:22-bookworm-slim`, runs as a non-root user, and stores data
in `/data`.

## Compose

```bash
cp .env.example .env
# fill in secrets
docker compose up -d
```

`docker-compose.yml` runs the API and a separate worker. For production, add a
reverse proxy with TLS and a Postgres service.

## Postgres

```bash
REVLYRA_DB_DRIVER=postgres
REVLYRA_DATABASE_URL=postgres://revlyra:secret@postgres:5432/revlyra
```

- Run `revlyra db migrate` once before starting.
- Use a connection pool (default 10).
- Multiple API replicas can share Postgres; run workers separately.
- Back up with `pg_dump`.

SQLite is appropriate for single-node deployments up to a few million reviews.
Use Postgres for multi-instance API/worker setups.

## Separate API and worker

```bash
revlyra serve --no-worker
revlyra worker
```

The worker handles scans, media, campaigns, integrity snapshots, and retention.
Scale workers horizontally with Postgres; `FOR UPDATE SKIP LOCKED` prevents
double-claiming.

## systemd

```ini
[Unit]
Description=Revlyra API
After=network.target

[Service]
WorkingDirectory=/opt/revlyra
EnvironmentFile=/etc/revlyra/revlyra.env
ExecStart=/usr/bin/node /opt/revlyra/packages/revlyra/dist/cli/index.js serve
Restart=on-failure
User=revlyra
Group=revlyra
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/revlyra

[Install]
WantedBy=multi-user.target
```

Repeat for `revlyra worker` without `serve`.

## Reverse proxy

- Terminate TLS; forward only to the private API address.
- Set `REVLYRA_TRUST_PROXY=true` only when the proxy is trusted.
- Preserve `Authorization`, `Content-Type`, `Idempotency-Key`, `X-Revlyra-Tenant`.
- Set request body limits at least as large as Revlyra's.
- Restrict `/v1/admin/*` to an internal network or VPN.

## Backups

```bash
revlyra db backup --out /backups/revlyra-$(date +%F).db
revlyra audit export --out /backups/audit-$(date +%F).jsonl
```

For Postgres, use `pg_dump` and test restores. Back up the `.revlyra/` config and
license files separately from the database.

## Health and observability

- `GET /v1/health` — liveness + license status.
- `GET /v1/version` — server/core/model/policy versions.
- Structured pino logs; ship to your SIEM.
- Track: decision rates, appeal overturn rate, scan failures, job latency, p95
  analysis latency, rate-limit counts, license usage.

## Scaling targets

| Metric                    | Target                                  |
| ------------------------- | --------------------------------------- |
| Text + behaviour analysis | p50 < 15 ms, p95 < 40 ms                |
| HTTP throughput           | ≥ 500 reviews/s (single node, batching) |
| SQLite                    | ~5M reviews on one node                 |
| Postgres                  | 50M+ reviews                            |
| Campaign job              | 500k edges < 60 s                       |

## Upgrades

1. Back up the database.
2. Run `revlyra db migrate`.
3. Roll out the API, then workers.
4. Check `revlyra doctor` and `/v1/version`.
5. Verify the audit chain.

Migrations are forward-only. Test upgrades against a copy of production.
