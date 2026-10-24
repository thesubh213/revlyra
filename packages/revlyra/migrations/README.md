# Migrations

Revlyra applies its schema from the versioned schema definition embedded in
`src/store/schema.ts` via:

```bash
revlyra db migrate
```

This is intentional: the package has no separate migration runner, no native
dependencies, and works offline. The schema is forward-only and records applied
versions in `schema_migrations`.

For SQLite, migrations run inside `revlyra db migrate`. For Postgres, run the same
command once before starting API/worker processes.

If you need raw SQL for review or provisioning, use `SQLITE_SCHEMA` /
`POSTGRES_SCHEMA` from `src/store/schema.ts` as the source of truth. Back up the
database before upgrading.
