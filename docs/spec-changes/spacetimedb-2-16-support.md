# SpacetimeDB 2.16 support

**Status: on-going**

> Active spec-change record. It may be updated while the work is in progress. When all phases are
> complete, change the status to `completed` and treat it as readonly historical data.

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
- [ ] Phase 2 — Subscription error contract: align docs and tests with the SDK's 2.16 callback-error
      behavior; optionally prefer the SDK's second `error` argument with a `ctx.event` fallback.
- [ ] Phase 3 — Tiered storage policy and app guidance: apply the library table policies above, add
      schema tests, and document recommendations for app state tables, projections/read models, event
      tables, parameterized views, and the 3.0 default change.
- [ ] Phase 4 — Final consistency and release prep: close this record, align the design record and
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

## Current state

Phase 1 is complete. Phase 2 is next. No API signatures have changed.
