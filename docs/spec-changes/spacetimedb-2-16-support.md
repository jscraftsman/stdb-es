# SpacetimeDB 2.16 support

**Status: completed**

> Completed spec-change record. All phases are done; treat this as readonly historical data.

## Scope

SpacetimeDB 2.16.1 and 2.16.3 add optional tiered storage, change how TypeScript SDK callback errors
are handled, and tighten republish-name permissions. This record tracks aligning `stdb-es` with those
releases without changing the framework-neutral client contract.

- The core API stays framework-neutral; `.` and `./client` gain no framework, DOM, or Node-only APIs.
- No core API signature change is required for 2.16 compatibility.
- The peer floor becomes `spacetimedb >=2.16.3 <3` so there is one documented callback-error behavior.
- `stdb-es/testing/integration` remains Node/CLI-only.
- This record does not touch `CHANGELOG.md`; release notes stay owned by the existing release flow.

## Decisions

- Keep `withIndexRanges`: 2.16.3 still bundles a second `Range` class inside the module test harness,
  so the shim is still needed. Its documentation becomes version-neutral.
- Keep `onError` optional in `subscribeEventRows`. Under 2.16 the SDK logs callback throws, so supplying
  `onError` is the deterministic way for apps to handle subscription errors.
- Opt `esEvent` into `no_requirement` tiered storage; explicitly pin `esStream` and `esHead` to
  `required_in_memory`. These are the library-owned table policies.
- Publish app-developer guidance for choosing `cachePolicy`, including the note that 3.0 changes the
  default to `no_requirement`, so tables that must stay resident need an explicit `required_in_memory`.

## Phase checklist

- [x] Phase 1 — Version support baseline: peer/dev/example/CLI version bumps, regenerated bindings,
      version-neutral harness notes, new spec-change record, and full 2.16.3 verification.
- [x] Phase 2 — Subscription error contract: align docs and tests with the SDK's 2.16 callback-error
      behavior; prefer an optional SDK `error` argument with a `ctx.event` fallback.
- [x] Phase 3 — Tiered storage policy and app guidance: apply the library table policies above, add
      schema tests, and document recommendations for app state tables, projections/read models, event
      tables, parameterized views, and the 3.0 default change.
- [x] Phase 4 — Final consistency and release prep: close this record, align the design record and
      README status, run all gates, and leave release notes to the maintainer.

## Phase 1 verification

All gates passed against CLI and SDK `2.16.3`:

- build, library/example typechecks, 137 library unit tests, both offline example suites, and the
  fresh-app pack check;
- live publish smoke twice, confirming both first publish and republish with `--delete-data=always`,
  plus a normal republish without that flag under the tightened name-permission rules;
- integration-kit smoke (19 checks), React example integration (5 tests), and Phaser example
  integration (5 tests);
- representative SQL recipes, including stream catalogue, aliased `position`, cache/stream join,
  `es_head`, and the anonymous public view;
- no API signatures changed. `withIndexRanges` remains necessary.

## Phase 2 verification

- The bridge's internal error callback accepts an optional second `error` argument while the exported
  `SubscriptionBuilder` type keeps the SDK's one-argument public shape. `subscribeEventRows` prefers
  that argument when a compatible builder supplies it and falls back to `ctx.event`.
- The public `onError` option keeps its `(error, ctx)` signature and stays optional. The bridge still
  throws when it is omitted, but docs now state that SDK 2.16 catches and logs callback throws, so
  apps should supply a handler for deterministic handling.
- Tests cover SDK-shaped one-argument builders, second-argument preference with `ctx.event` fallback,
  and the no-handler throw. All 139 library tests pass, along with build, typecheck, both example
  typechecks, the fresh-app pack check, and the live integration-kit smoke (19 checks).
- No framework, DOM, or Node-only APIs were added to `.` or `./client`.

## Phase 3 verification

- `esStream` and `esHead` explicitly set `cachePolicy: 'required_in_memory'`; `esEvent` sets
  `cachePolicy: 'no_requirement'`. SDK 2.16 emits only the non-default policy in `moduleDef`, which the
  new schema test verifies.
- `docs/usage-guide.md` §1.3a gives app recommendations for state caches, ownership tables,
  projections/read models, event/archive tables, parameterized views, and the SDK 3.0 default change.
  `docs/API.md` and `docs/event-sourcing-plan.md` point to the same contract.
- All 143 library tests pass, including the new cache-policy tests. Build, typecheck, both example
  typechecks, both offline example suites, the fresh-app pack check, both live example integration
  suites (5 tests each), and the live integration-kit smoke (19 checks) pass under CLI 2.16.3.
- Regenerating both examples' client bindings produced no changes. No public API signatures changed,
  and no framework, DOM, or Node-only APIs were added to `.` or `./client`.

## Phase 4 verification

- The record is closed as `completed` and is now readonly historical data. `docs/event-sourcing-plan.md`
  and `README.md` now describe 2.16.x support as complete while keeping React and Phaser as reference
  UIs. `CHANGELOG.md` and npm publishing remain maintainer-owned; neither was touched.
- Final gates passed: build, library typecheck, 143 library tests, both example typechecks, both offline
  example suites, the fresh-app pack check, the integration-kit smoke (19 checks), and both live example
  integration suites (5 tests each).
- Live publish verification used a disposable in-memory CLI 2.16.3 server on a free port: clean publish
  with `--delete-data=always`, 19 publish-smoke checks, owner and anonymous SQL spot-checks, and a normal
  republish without `--delete-data`. The temporary server was stopped and the configured `local` server
  was left unchanged.
- Representative SQL returned the expected stream version, aliased event positions, `es_head`, and the
  anonymous `counter_summary` view. Regenerating client bindings produced no changes.
- No public API signatures changed. No framework, DOM, or Node-only APIs were added to `.` or
  `./client`.

## Current state

All four phases are complete. The SpacetimeDB 2.16 support change is closed; release notes remain
maintainer-owned.
