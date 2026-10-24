# Security policy

## Supported versions

This project is pre-1.0. Security fixes are made to `main` and released with the
next npm publish. Please track the latest release.

## Report a vulnerability

**Do not open a public issue for security problems.**

Use GitHub's private vulnerability reporting on this repository:

<https://github.com/thesubh213/revlyra/security/advisories/new>

Alternatively, contact the maintainer through the email address listed in the
commit history. You can expect an initial response within a few days.

## Scope notes

- This engine processes review data from your own databases in read-only mode.
  Vulnerabilities in **your** review platform, your reverse proxy, or hosts
  you integrate with are out of scope.
- In scope: the HTTP API surface (`packages/revlyra/src/server`), source
  adapters (SSRF protections in `sources/safe-url.ts` and `media/fetch-image.ts`),
  license/token verification (`license/`), webhook signature handling, and
  anything enabling identity de-anonymization (privacy.ts and its callers).
- The technical threat model lives in [docs/SECURITY.md](docs/SECURITY.md) and
  [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md).

## Disclosure expectations

We will credit reporters in the changelog on request, keep you updated on
progress, and publish an advisory once a fix is released.
