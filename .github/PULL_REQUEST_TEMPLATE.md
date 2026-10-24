<!--
Thanks for the PR! Before opening:
  pnpm lint && pnpm typecheck && pnpm test && pnpm build
Describe what changed and why; reviewers run the same checks in CI.
-->

## Summary

<!-- 2-5 sentences: what changed and why (link issues with “Fixes #123”). -->

## Changes

- …

## Checklist

- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` pass locally
- [ ] New behavior is covered by tests (detectors, store, API routes, CLI)
- [ ] Docs under `docs/` updated if behavior or configuration changed
- [ ] Reason codes are never renamed (codes are an API contract — see `packages/core/src/codes.ts`)
- [ ] No raw IPs, reviewer identifiers, or secrets added to tests or fixtures
- [ ] Signed reviews? Words in `docs/COMPLIANCE.md` still match user-facing surfaces if touched

## Risk and rollback

<!-- What could this break (scoring, storage, privacy)? How do we roll back (policy knob, feature flag, rebuild)? -->
