# Security

## Threat model

| Asset                | Threat                                                                        | Control                                                                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review/reviewer data | Unauthorized access, cross-tenant leakage                                     | Tenant-scoped store methods, bearer auth, optional Postgres RLS, isolation tests                                                                         |
| PII                  | Leakage through logs, evidence, exports                                       | Tenant-scoped HMAC identifiers, IP truncation, contact masking, pino redaction, retention                                                                |
| API keys             | Theft, enumeration, replay                                                    | SHA-256 hash-only storage, prefix routing, identical 401s, rate limits, expiry/revocation                                                                |
| License              | Forgery, sharing, revocation bypass                                           | Ed25519 signatures, install-bound leases, online revocation, offline grace                                                                               |
| Source credentials   | Leak via DB/config/logs                                                       | Env references only, `credentialRef`, least-privilege read-only roles                                                                                    |
| Source databases     | Accidental writes, injection                                                  | Read-only transactions, parameterized queries, single-statement validation, timeouts                                                                     |
| Media URLs           | SSRF, DNS rebinding, decompression/size abuse                                 | HTTPS, DNS checks, redirect revalidation, size/time caps, content-type allowlist                                                                         |
| Webhook target       | SSRF to internal services                                                     | Admin-configured only; HTTPS required (localhost HTTP allowed); signed payloads                                                                          |
| Audit trail          | Tampering                                                                     | Hash chain (`prev_hash + canonical payload`), verification command                                                                                       |
| Supply chain         | Malicious package or postinstall                                              | No postinstall scripts, lockfile, npm provenance, SBOM, dependency review                                                                                |
| Adversarial text     | ReDoS, parser bombs                                                           | No user-supplied regex, size caps, linear tokenization, optional worker isolation                                                                        |
| Adversarial text     | Prompt injection against AI tiers (doc §3.2)                                  | Pattern lexicon; `modelText` sanitizer (`[sanitized]`) is the only copy passed to the optional embedding/classifier tier; detection capped, never `hard` |
| Identity metadata    | Caller payloads carrying full names / resume URLs (Glassdoor class, doc §2.3) | `REVLYRA_IDENTITY_MINIMIZATION` key/value scrubbing before persistence + audited strips                                                                  |
| Reviewer identity    | Retroactive pseudonym de-anonymization                                        | HMAC-only identifiers; no third-party identity enrichment; platform contract forbids submitting real identity fields                                     |

## API keys

- Format: `rvlyra_live_<prefix>_<32-byte base64url secret>`.
- Store `prefix` and `SHA-256(secret)`, never the raw key.
- Lookup is O(1) by hash; unknown, revoked, and expired keys return the same 401.
- Scopes: `analyze:write`, `feedback:write`, `scan:write`, `admin`.
- Rotate by creating a new key, deploying it, then revoking the old one.
- `REVLYRA_ADMIN_KEY` is separate; admin routes are disabled if unset.

## Licenses

- Dev keys are locally registered hashes, 30 days, evaluation-only.
- Production tokens: `rvlyra_lic_v1_<payload>.<Ed25519 sig>`, verified offline.
- Leases: `rvlyra_lease_v1_…`, 24 hours, `installIdHash`-bound.
- Revocation stops new leases; cached leases honor a configurable grace window
  (default 7 days), after which new analyses are blocked.
- The private signing key belongs in a KMS/HSM, never in the npm package or repo.

**Honest limit:** shipped code can be patched. Licensing is entitlement and
compliance, not unbreakable DRM. Server-side lease enforcement, contracts, and
audit are the practical maximum.

## Media fetching

- Only `http`/`https`; private, loopback, link-local, carrier-grade NAT, and
  multicast ranges are blocked.
- Hostnames are resolved and all returned addresses are checked.
- Redirects are followed manually, revalidated at each hop, and capped at 3.
- 10 MB maximum, image content types only, 10-second timeout.
- DNS rebinding remains a theoretical TOCTOU risk; deploy egress controls where
  the threat model requires it.

## Input and database safety

- Zod validation and size caps at the API boundary.
- Parameterized SQL everywhere; dynamic identifiers are allowlisted.
- Custom source SQL is one `SELECT`/`WITH`, no semicolons, read-only transaction.
- Prototype-pollution keys are stripped by schema parsing.
- Media decode failures are contained; optional `sharp` runs with pixel limits.

## Logging

- pino redacts `authorization` and `cookie` headers.
- Review text and evidence are not logged by default.
- Request IDs are returned to clients for support.
- Never log raw API keys, license keys, peppers, or source URLs with credentials.

## Deployment hardening

1. Terminate TLS at a reverse proxy; bind the API to localhost or a private network.
2. Set `REVLYRA_TRUST_PROXY=true` only behind a trusted proxy.
3. Use a read-only database role and a replica for source adapters.
4. Run the API and worker as separate processes for production.
5. Encrypt disks/volumes; back up the SQLite file with `revlyra db backup`.
6. Restrict admin routes to an internal network.
7. Keep `REVLYRA_ADMIN_KEY` only in a secret manager.
8. Run `revlyra doctor`, `revlyra audit verify`, and dependency audits regularly.

## Supply chain

- No `postinstall` scripts.
- Optional native dependencies are lazily loaded.
- Publish with npm provenance and 2FA.
- Pin CI actions and the pnpm store; review lockfile diffs.
- Generate an SBOM in CI (`pnpm licenses list` / CycloneDX) before release.

## Reporting a vulnerability

Do not open a public issue for security problems. Email the maintainers with a
description, reproduction, affected version, and impact. We aim to acknowledge
within a few business days and will coordinate disclosure.

## Out of scope

- Proving that a review is fraudulent.
- Detecting every coordinated human farm.
- Protecting against a compromised host or stolen admin key.
- Legal advice.
