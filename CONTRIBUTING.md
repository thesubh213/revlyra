# Contributing to Revlyra

Thanks for your interest in contributing. Revlyra produces **calibrated risk
signals**, not proof that a review is fake — every PR here eventually shapes
moderation decisions, so tests and honesty in docs matter more than cleverness.

## Setup

```bash
corepack enable
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm lint
```

Run the full stack against a scratch directory:

```bash
mkdir demo && cd demo
node ../packages/revlyra/dist/cli/index.js init
node ../packages/revlyra/dist/cli/index.js serve
```

## Ground rules

1. **Reason codes are an API contract.** Codes in `packages/core/src/codes.ts`
   are written to statements of reasons, audit chains, and downstream
   dashboards. Never rename them — a retired code stops being emitted but stays
   listed. New codes need a detector that emits them and a test asserting one.
2. **Tests are part of the spec.** New behavior ships with tests covering the
   happy path _and_ the edges (threshold boundaries, empty input, invalid data).
3. **Privacy is load-bearing.** Never persist raw IPs, raw reviewer identities,
   or un-hashed contact data. If a PR touches `privacy.ts`, `context.ts`, or
   store writes, reviewers will look for HMACs and identity scrubbing.
4. **Detectors must not punish shared infrastructure.** NAT'd offices, shared
   devices, and family accounts are legitimate. Raise concerns via confidence,
   not severity, and document the caution in the signal evidence.
5. **Safety signals never fuse into fraud scores.** `SAFETY_REVIEW` routes to
   humans and is deliberately low-weight. Preserve that invariant.
6. **No secrets, no telemetry.** Never commit `.env.local` or real keys, and do
   not add outbound calls that phone home.

## Commit and PR style

- Small, focused PRs beat drive-by refactors.
- Conventional, present-tense commit messages ("Add X", "Fix Y").
- CI runs lint, typecheck, tests, build, and the synthetic eval gate
  (`pnpm eval`) — keep it green before requesting review.
- Update `CHANGELOG.md` for user-visible changes.

## Reviewing

Reviewers check: correctness of thresholds vs docs, test quality, privacy
impact, and whether documentation still tells the truth after the change.
