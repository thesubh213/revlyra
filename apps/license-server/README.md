# Revlyra reference license server

Vendor-side control plane for signed licenses, activation limits, 24-hour leases,
usage metering hooks, and revocation. It is deliberately separate from the
customer-hosted Revlyra engine.

## Run

```bash
node scripts/keygen.mjs
export LICENSE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
export LICENSE_ADMIN_KEY="$(openssl rand -base64 32)"
export LICENSE_DB_PATH="./data/licenses.db"
pnpm build
pnpm start
```

Configure each Revlyra deployment with the matching public key and the server URL:

```bash
REVLYRA_LICENSE_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
REVLYRA_LICENSE_SERVER="https://license.example.com"
```

## Issue a license

```bash
curl -X POST http://127.0.0.1:8790/v1/licenses \
  -H "Authorization: Bearer $LICENSE_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "sub": "tenant_acme",
    "tier": "pro",
    "features": ["server","sdk","api_access","webhooks","media","campaigns","graph"],
    "limits": {"reviewsPerMonth": 1000000, "sources": 25, "rps": 100, "seats": 10},
    "expiresInDays": 365
  }'
```

The returned `license` value goes into the customer's `REVLYRA_LICENSE_KEY`.
`GET /v1/public-key` exposes the verification key. Revoke with
`POST /v1/licenses/:jti/revoke`; leases stop being issued immediately.

## Notes

- This is a reference implementation, not a hardened multi-region service.
- Use a KMS/HSM-backed signer and Postgres in production.
- Store only hashed install IDs; never collect hardware serials.
- The license server never receives review text or reviewer PII.
