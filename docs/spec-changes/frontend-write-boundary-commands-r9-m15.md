# 18. Frontend write boundary: commands instead of append (R9 / M15)

**Status: completed** — requirement, implementation, examples, tooling, and documentation migrated through Phase 6.

> Read-only historical record. Do not update this document when later work moves paths or changes
> APIs. Subsequent scope changes get their own document under `docs/spec-changes/`.

This document is the authoritative statement of the change. It does not alter the shipped M0–M8
record in §13–§17 of the design record; it defines the breaking change that supersedes parts of it
when delivered.

### 18.1 The flaw

SpacetimeDB reducers are public callables. The shipped browser write path hands client code the
whole event envelope: `createEventStoreClient(...).append(streamId, streamType, events, options)`
encodes events in the browser and passes `AppendCallArgs` to a generated `append_events` reducer
(§13), which `makeAppendReducer` builds from caller-supplied `streamId`, `streamType`,
`expectedVersion`, and an array of `{ eventId, eventType, data, metadata }` (§4). Consequences:

1. **Data shaping.** A browser user can send any `eventType` and any `data` string, bypassing the
   app's event registry and domain validation. The registry is only advisory on this path.
2. **Cross-stream writes.** `appendToStream` trusts the caller's `streamId`/`streamType`; it has no
   ownership check. A user can target any stream, including one owned by another user.
3. **Client-side authorization is not a boundary.** Any check in React event handlers or in a
   client helper can be skipped by calling the reducer directly from devtools or a script.
4. **Auditing is not prevention.** `createdBy: ctx.sender` records who wrote a bad row, but does not
   stop the write.

Therefore a raw append must not be reachable from browser-facing code, and a generic
`append_events` reducer must not remain exported from an app module — otherwise the flaw survives
even if the UI stops using the client helper.

### 18.2 Target contract

**The client sends intent (a command); the backend decides facts (events).**

| Concern | Shipped path (before) | Target path (M15) |
| --- | --- | --- |
| Frontend write call | `client.append(streamId, streamType, events, ...)` → generated `append_events` | generated `increment` / `decrement` / `reset` reducer with a command payload |
| Who builds the event envelope | browser (`encodeEvents`) | backend command reducer |
| Who chooses `streamId` / `streamType` | caller-supplied | derived server-side from validated command fields and an app-owned ownership table |
| Who chooses `eventType` / `data` | caller-supplied | backend event factory / registry |
| Who owns idempotency | browser `newEventId()` event ids | caller `commandId`; backend derives deterministic event ids from it |
| Who validates | browser registry (advisory) | backend command handler (authoritative), using `ctx.sender` |
| Public reducer surface | generic `append_events` | only app-defined command reducers |
| Reads | subscription / view / `decode` | unchanged |

The browser never supplies `streamId`, `streamType`, `eventType`, `data`, `eventId`, `position`, or
`expectedVersion`. Its entire write vocabulary is the set of command reducers the module exports.

### 18.3 Command payload contract

1. **Declared in the backend module.** A command is a plain SpacetimeDB type (for example
   `t.object('IncrementCounter', { counterId: t.string(), by: t.u32(), commandId: t.string() })`)
   used as a reducer argument type. Command names and shapes are part of the backend API.
2. **Mirrored to the frontend by `spacetime generate`.** Web code imports command payload types
   from its generated bindings (the counter set already generates into `web/src/generated/`); it
   must not redeclare them. A generated command reducer is the only callable write surface.
3. **Idempotency key.** Every command carries a caller-generated `commandId` (an opaque string;
   `newCommandId()` defaults to `crypto.randomUUID()`). The backend derives event ids deterministically
   from the command id, so a retry of the same command deduplicates in `appendToStream` instead of
   appending twice.
4. **Server-side derivation.** The reducer resolves `streamId` via app-owned constants
   (`streamId(STREAM_PREFIXES_COUNTER.counter, command.counterId)`), checks ownership against
   `ctx.sender`, validates domain rules (for example `by > 0`), builds encoded events, and calls
   `appendToStream` with a server-chosen `expectedVersion`.
5. **Failure semantics.** Invalid command, unknown stream, missing ownership, or stale version
   rejects before any write with a stable error code (app `CMD_*` or existing `ES_*`). Reducers
   still return `void`; the client observes the new state through its subscription/view (§7).
6. **No generic fallback.** `makeAppendReducer` and any exported `append_events` reducer are removed
   from the shipped write path (Phase 2 for the package, Phase 5 for the examples). Keeping one
   would leave a callable bypass.

### 18.4 Counter example migration

> Historical M15 record: paths below reflect the tree before the example-layout cleanup. Both counter
> examples have since been consolidated into the baseline set (§15.2).

Both `examples/counter` and `examples/sets/counter-with-frontend` migrate in Phase 5. The web app
stops importing the generic append client and calls generated reducers with intent only:

```ts
// web: command payload types come from `spacetime generate`
await conn.reducers.increment({ counterId, by: 1, commandId: newCommandId() });
await conn.reducers.decrement({ counterId, by: 1, commandId: newCommandId() });
await conn.reducers.reset({ counterId, commandId: newCommandId() });
```

```ts
// module: the only place that appends for this stream type
export const increment = spacetimedb.reducer(IncrementCounter, (ctx, command) => {
  const stream = authorizeCounter(ctx, command.counterId); // throws for non-owners
  appendToStream(ctx, {
    streamId: stream.streamId,
    streamType: STREAM_TYPES_COUNTER.Counter,
    expectedVersion: stream.version,
    events: [encodeIncrement(command)], // event id derived from commandId
  });
  updateCounterStateCache(ctx, stream.streamId); // same inline path as today
});
// decrement and reset follow the same shape; no append_events reducer is exported
```

Acceptance for the example: a browser calling `increment` on another owner's `counterId` fails; a
retried command with the same `commandId` does not double-increment; the anonymous summary view and
`stream_events` subscription behave as before.

### 18.5 Compatibility and impact

This is a **breaking change** to the client write API and to module reducer exports. Affected
surfaces, all owned by phases in §18.6:

- `stdb-es/client`: `AppendCallArgs`, `AppendCall`, `EventStoreClientOptions.append`,
  `createEventStoreClient(...).append/.retry`, and browser-side `encodeEvents` for writes.
- `stdb-es/server`: `makeAppendReducer` (no longer a shipped write-path factory).
- `stdb-es/testing`: `createFakeAppend` was removed in the post-M15 unit-kit cleanup; the contract
  suite's `appendEvents` seam (now augmented by optional command-boundary checks) remains server-only.
- `stdb-es/testing/integration` and smoke scripts: `env.call('append_events', ...)` — migrated in
  Phase 4 to command reducer calls against a publishable command fixture.
- Examples and their README suites — migrated in Phase 5. `docs/API.md` / `docs/usage-guide.md` /
  integration and unit guides, plus `README.md` scripts — migrated in Phase 6.

Read-side helpers (`decode`, upcasters, `sliceRows`, subscriptions, views, `viewQuery`,
`tableQuery`) are intentionally unaffected.

### 18.6 Phased rollout

Each phase starts only after an explicit go signal and completes its own checks before the next is
proposed. "If necessary" is decided at the start of that phase, not assumed. The status table and
intermediate-state notes below are a historical record of M15; their example paths are not current.

| Phase | Scope | Exit criteria | Status |
| --- | --- | --- | --- |
| 1 | Requirements/plan docs — this document | Flaw, target contract, command payload rules, counter mapping, impact, and phases recorded; R9, M15, risk, and decision entries added | done |
| 2 | Package source (`src/client`, `src/server`) | Browser-facing append/retry surface removed; `makeAppendReducer` no longer in the shipped write path; optional command-dispatch helper uses generated reducers; read/decode/subscribe helpers unchanged; typecheck, unit suite, build, pack check green | done |
| 3 | Unit testing kit (`src/testing`) if necessary | Fake append seam replaced/augmented by a fake command dispatcher; contract suite adapted to command reducers; offline tests green | done |
| 4 | Integration testing kit (`src/testing/integration`) if necessary | Generic `append_events` calls in kit docs, tests, and smoke scripts replaced by command reducer calls; local and external URL modes green | done |
| 5 | Examples (`examples/counter`, `examples/sets/counter-with-frontend`) | No browser path can call a generic append; `increment`/`decrement`/`reset` module reducers validate ownership; command payload types come from generated bindings; example typechecks, unit tests, and integration tests green | done |
| 6 | Remaining docs (`usage-guide.md`, `API.md`, `README.md`, unit/integration guides, plan status) | No frontend-append snippets remain; command contract and new exports documented; phase status updated; markdown links/fences green | done |

**Phase 2 intermediate state.** The package's own gates are green: root `typecheck`, 118 offline
unit tests (including the new command-client suite), clean `build`, and `check:pack`. Examples still
import the removed APIs, so `example:typecheck`, `example:set:counter:typecheck`, and the publish
smokes stay red **by design** until Phase 5 migrates them. Phase 2 kept the fixture module's
test-only generic append reducer so the store's own harness tests and contract suite remain
meaningful; the integration toolkit still targets it and migrates in Phase 4.

**Phase 3 intermediate state.** The unit kit now exports `createFakeCommand` as the browser-boundary
stand-in and keeps `createFakeAppend` as a deprecated migration aid. The contract suite accepts an
optional `commands` block and dogfoods it against the fixture's `increment` reducer, covering
single-append command handling, `commandId` replay, and rejection when the sender has no ownership
row. Root offline tests are green at 124 tests. The integration toolkit still calls
`append_events` and migrates in Phase 4.

**Phase 4 intermediate state.** The integration kit remains reducer-agnostic. A publishable command
fixture at `test/integration-module` provides `claim_counter`, `increment`, `decrement`, and `reset`
so the live kit smoke can migrate without pulling Phase 5 example work forward. The smoke now checks
command writes, `commandId` replay, non-owner rejection, subscriptions, cache rebuild, and external
URL mode; all 16 checks pass. `docs/integration testing.md` and the CLI-formatting test use command
payloads. Examples and their publish/integration suites still target `append_events` by design until
Phase 5.

**Phase 5 intermediate state.** Both counter examples now export only `increment`, `decrement`, and
`reset` command reducers. The reducers derive the stream id, deterministic event id, event type,
payload, and expected version from intent-only payloads, claim ownership on first use, and reject a
different `ctx.sender`. The React client imports command payload types from `spacetime generate`
output and dispatches through `createCommandClient`; generic append bindings were removed. Offline
module tests, web command tests, the five-test live integration suite, `example:set:counter:publish`
(preserving data), `publish-clean`, and the 19-check publish smoke all pass.

**Phase 6 completion state.** Active documentation now describes the command write contract only.
`README.md`, `docs/API.md`, `docs/usage-guide.md`, and `docs/unit testing.md` use generated command
reducers, `createCommandClient`, `createFakeCommand`, and the contract suite's optional `commands`
check. Server-only `appendToStream` remains documented as a module seam; `createFakeAppend` is marked
deprecated. `docs/integration testing.md` needed no further migration. The plan status and M15 row
are complete, and the markdown link/fence check is green.

**Post-M15 audit state (Phases 3–5 cleanup).** `createFakeAppend` and its
`AppendCallArgs`/`AppendCall`/`FakeAppend*` types are no longer exported from `stdb-es/testing`;
client tests use `createFakeCommand`. The contract suite's `append` option remains a server-only
fixture seam for store invariants, and the optional `commands` block covers the browser boundary.
Phase 4 keeps the integration kit reducer-agnostic and command-based: no browser append binding was
reintroduced, and an attached environment (`publish: false`) keeps its database on `dispose()` by
default. Phase 5 keeps both examples command-only: generated bindings expose only `increment`,
`decrement`, and `reset`; the web app dispatches through `createCommandClient`; and the example
typechecks, unit tests, and live integration suite are green. The Phase 3 and Phase 6 entries above
remain the historical M15 rollout record.

Independent of M15, M9–M13 and M14 stay paused/deferred as recorded in §15.

### 18.7 Definition of done for M15

- No module in the repository exports a generic append reducer reachable from a browser.
- No browser code constructs `streamId`, `eventType`, `data`, `eventId`, or `expectedVersion` for a
  write; command payload types are imported from `spacetime generate` output.
- Authorization is enforced in command reducers against `ctx.sender`, with a negative test for a
  non-owner targeting another user's stream.
- Retrying a command with the same `commandId` is an idempotent replay, not a duplicate event.
- All existing CI layers (build, typechecks, offline tests, pack check, live smoke, integration
  smoke, example tests) remain green after the migration.
