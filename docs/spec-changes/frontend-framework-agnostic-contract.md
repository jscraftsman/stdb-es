# Frontend-framework agnostic client contract

**Status: on-going**

> Active spec-change record. It may be updated while the work is in progress. When all phases are
> complete, change the status to `completed` and treat it as readonly historical data.

## Scope

The package must work in any TypeScript frontend with little or no difference in its client API.
React and Phaser are reference UIs, not part of the package contract.

- `stdb-es` and `stdb-es/client` must remain free of framework, DOM, and Node-only dependencies.
- Command dispatch, idempotency, decoding, subscriptions, and query helpers must use plain async and
  callback APIs.
- Framework-specific connection lifecycle belongs in example and documentation code, not in the
  shared package.
- `stdb-es/server` stays server-module-only; `stdb-es/testing/integration` stays Node/CLI-only.
- Consumers of `stdb-es/testing` use Vitest. The unit kit is not runner-agnostic.

## Decisions

- No React hooks, providers, Phaser adapters, or framework entry points will be added to the package.
- Vitest is a required dependency for test-kit consumers; the `./testing` entry point is not split.
- The new `phaser-counter` example will mirror `react-counter` while sharing the same command
  contract and module behavior.
- Historical write-boundary records remain unchanged.

## Phase checklist

- [x] Phase 1 — Core API: add neutrality guards and the optional injected command-ID generator.
- [x] Phase 2 — Unit testing kit: confirm the Vitest-based kit works for all frontend examples.
- [x] Phase 3 — Integration testing kit: confirm the Node/CLI boundary is isolated from frontend code.
- [x] Phase 4 — `react-counter`: keep React as the reference UI with no API drift.
- [x] Phase 5 — Docs: document the framework-neutral contract and lifecycle.
- [ ] Phase 6 — `phaser-counter`: add the Phaser example and root plumbing.
- [ ] Phase 7 — Docs: document the new example.
- [ ] Phase 8 — Review all docs and verification gates for consistency.

## Current state

Phase 5 is complete. The README, API reference, usage guide, unit/integration testing guides,
publishing guide, and active design-record entries now describe the framework-neutral contract,
required Vitest peer, Node/CLI integration boundary, and subscribe/unsubscribe/disconnect lifecycle.
Awaiting the go signal for Phase 6.
