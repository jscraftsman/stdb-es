# Permissions example (M16)

**Status: on-going**

> Active spec-change record. It may be updated while the work is in progress. When all phases are
> complete, change the status to `completed` and treat it as readonly historical data.

## Scope

M16 adds a new full-stack example set at `examples/permissions/`, labeled **M16**, that teaches
authentication and authorization with the existing counter domain. It is example and documentation
work, not a new core package feature.

- Authentication uses Google Identity Services ID tokens directly as SpacetimeDB OIDC tokens. It
  does **not** use SpacetimeAuth, a custom token-exchange server, a client secret, or Google access
  tokens.
- Authorization is enforced in module reducers and views. The frontend is a reference UI only.
- `.`, `./client`, `stdb-es/server`, and the public API signatures remain unchanged.
- `stdb-es/testing/integration` remains Node/CLI-only.
- Generated bindings are committed from CLI 2.16.3 and never hand-written.
- The reference UI lists all public counters: one C1 card plus one C2 card per authenticated user.
  C2/C3 cards are hidden while logged out; C1 controls stay usable anonymously.
- Logged-in users see every C2 card but only their own card has enabled write controls. Module-side
  ownership checks remain authoritative.
- C1, C2, and C3 cards use different accents while keeping the same value, amount, and action
  elements.
- Sign-in state is derived only from the stored Google ID token. SpacetimeDB's automatically issued
  anonymous connection token is stored separately, so an anonymous C1 session never appears signed
  in and sign-out really returns to an anonymous identity.
- This record does not touch `CHANGELOG.md`; release notes stay maintainer-owned.

## Counter contract

| Counter | Instance rule | Read visibility | Write visibility | Identity used for ownership |
| --- | --- | --- | --- | --- |
| **C1 — Global public** | One fixed stream for the whole app | Everyone, including anonymous clients | Everyone, including anonymous clients | Not applicable |
| **C2 — Public read, private write** | One stream per authenticated Google user | Everyone | Owner only | `ctx.sender`, derived from Google `iss` + `sub` |
| **C3 — Private read and write** | One stream per authenticated Google user | Owner only | Owner only | `ctx.sender`, derived from Google `iss` + `sub` |

All three counters use the existing command shape: the browser sends counter id, optional amount, and
`commandId`; the module derives the stream id, event id, event type, payload, and expected version. No
generic append path is exposed.

### Read model plan

- Private materialized tables hold one state row per stream. Clients never subscribe to them.
- State rows carry optional owner identity and email. C1 has neither; C2 and C3 rows are stamped from
  the verified JWT so public C2 cards can name their owner without reading the private owner table.
- A public anonymous view exposes C1 and C2 rows.
- A per-caller view exposes only the caller's C3 row.
- `clientConnected` creates the single zero-valued C1 row and, for valid Google identities, the
  caller's zero-valued C2 and C3 rows. The number of public C2 cards therefore tracks the number of
  authenticated users, not the number who happened to click a button first.
- A public parameterized event view allows only C1 and C2 streams.
- A separate per-caller parameterized event view allows only the caller's C3 stream.
- No view exposes all event streams.

### Write authorization plan

- C1: no JWT requirement; any sender may increment, decrement, or reset the one global stream.
- C2/C3: require a JWT whose issuer is Google and whose audience contains the configured Google
  OAuth client ID. SpacetimeDB derives the identity from `iss` + `sub`; the stream id is deterministic
  from counter type plus that identity, so one user cannot create a second instance by choosing a
  different id.
- `clientConnected` allows anonymous connections so C1 and C2 reads remain public. A saved
  server-issued SpacetimeDB token (`aud: ["spacetimedb"]` plus matching `hex_identity`) is accepted
  only as an anonymous reconnect token; every other supplied token must be a Google ID token for the
  configured client ID. Owned C2/C3 rows are created only for Google identities.
- Reducers still check the owner row with `.equals(ctx.sender)` before appending. A rejected command
  writes no event and no cache row.
- Google ID tokens expire after about an hour. The example documents that a long-lived connection
  keeps its identity until reconnection, and that signing in again produces a fresh token for a new
  connection.

## Google Cloud Console setup

This is the setup guide the example README carries. It uses the Sign In With Google button in
popup mode and needs no redirect URI or client secret. The example is configured for client id
`407348267584-b9dmdsvdbuiohlr5l459lbib0tkvbfed.apps.googleusercontent.com`.

1. Open the [Google Cloud Console credentials page](https://console.cloud.google.com/apis/credentials)
   and create or select a project, for example `stdb-es-permissions-local`.
2. Open **APIs & Services → OAuth consent screen**. Choose **External** for a local demo. Fill in
   the application name, user support email, and developer contact email. Add `localhost` to
   **Authorized domains**; add the production domain later when deploying. The default
   `openid`/`email`/`profile` scopes are enough. While the app is in **Testing**, add your own Google
   account as a test user; publish the consent screen only when the app is ready for other users.
3. Return to **Credentials**, choose **Create credentials → OAuth client ID**, and select
   **Web application**. Name it something like `stdb-es-permissions-web`.
4. Under **Authorized JavaScript origins**, add the exact browser origins used by the example:
   `http://localhost:5175` and `http://127.0.0.1:5175`. Origins include scheme, host, and port, with
   no path or trailing slash. For a deployed HTTPS origin, add that origin separately. Redirect URIs
   are not needed for popup mode.
5. Copy the **Client ID**. Do not create or copy a client secret; browser Sign In With Google uses
   only the ID.
6. Put the same client ID in the example's module configuration and in `web/.env.local` as
   `VITE_GOOGLE_CLIENT_ID`. `.env.local` is ignored by Git. The module value is an app constant in
   this example so the offline module harness can run without a host environment; it is not a secret.
7. The web page loads `https://accounts.google.com/gsi/client`, calls
   `google.accounts.id.initialize({ client_id, callback, ux_mode: 'popup' })`, and renders a button
   with `google.accounts.id.renderButton(...)`. The callback receives `credential`, the Google ID
   token. `DbConnection.builder().withToken(credential)` uses that token directly.
8. Use a full page reload/sign-in again when the token expires. The example does not use One Tap or
   silent refresh; One Tap requires an HTTPS domain and is out of scope.
9. If a browser blocks the Google popup, check the authorized origin and browser
   Cross-Origin-Opener-Policy. The example does not set a custom CSP; a production CSP must allow
   `https://accounts.google.com/gsi/client` and the GIS frame/connect origins.

## Decisions

- The example accepts Google ID tokens, with `https://accounts.google.com` as the expected issuer and
  the configured OAuth client ID in `aud`, for all authenticated identity. SpacetimeDB does not check
  `aud`, so the module must.
- Anonymous connections are allowed; otherwise the public C1 write/read case could not be shown.
  SpacetimeDB's server-issued token is not a Google credential, so it is recognized by its
  `spacetimedb` audience and matching `hex_identity` only for anonymous reconnects. Anonymous callers
  still fail C2/C3 write authorization.
- Counter ids are not trusted for owned counters. The module derives their streams from the verified
  sender identity and counter type.
- Unit tests use `TestAuth.fromJwtPayload` to cover Google-valid and invalid claim cases offline.
- Automated live integration tests require no Google credentials: they cover C1 writes and C2/C3
  rejection from anonymous identities. An opt-in live check with a real Google ID token covers the
  positive authenticated path and private-view isolation; it is skipped in CI.

## Phases

- [x] Phase 0 — Planning: create this M16 record, link it from the design record, and agree on the
      counter contract, Google setup flow, and phase boundaries.
- [x] Phase 1 — Backend module: add `examples/permissions/spacetimedb/` with the schema, auth
      helpers, command reducers, public/private views, and module configuration. No tests yet.
- [x] Phase 2 — Full-stack wiring: add the React client, Google sign-in flow, generated bindings,
      root npm scripts/workspaces/lockfile, and the example README with the Google Console guide.
- [x] Phase 3 — Unit tests: add module harness tests for issuer/audience validation, C1/C2/C3 write
      rules, idempotency, and view isolation, plus client tests for command payloads and token
      handling.
- [x] Phase 4 — Integration tests: add a separate Node-only suite for the live authorization matrix,
      including the opt-in real-Google-token check.
- [ ] Phase 5 — Final consistency: add CI gates and docs links, run the full verification set, and
      close this record as `completed`.

## Phase 0 verification

- No package source or public API was changed.
- The design record now links this active M16 record and lists M16 as a planned example set.
- Google authentication is designed around direct OIDC ID tokens, with module-side issuer and
  audience checks; no SpacetimeAuth dependency is introduced.

## Phase 1 verification

- `npx tsc -p examples/permissions/spacetimedb/tsconfig.json --noEmit` passes.
- `spacetime build -p examples/permissions/spacetimedb` succeeds with CLI 2.16.3.
- The module exports nine intent-only command reducers (three per counter), a `clientConnected`
  hook, two state views, and two event views. The browser never supplies a stream id, event id,
  event payload, or version.
- C1 uses the fixed `global-all` stream. C2 and C3 derive their stream ids from the verified
  sender's identity, and all owned writes validate Google issuer, audience, subject, and sender
  identity.
- `counter_public_summary` excludes C3 rows; `counter_private_summary` and `counter_private_events`
  filter by the caller's identity. `counter_public_events` refuses private streams through the
  stream type stored in the event catalogue.
- No test files were added in this phase, and no public API signatures changed.

## Phase 2 verification

- `npm run example:permissions:typecheck` passes for both module and web.
- `npm --prefix examples/permissions/web run build` produces a Vite bundle.
- `npm run example:permissions:build` builds the package and the module with CLI 2.16.3.
- Bindings were regenerated with CLI 2.16.3 and committed under `examples/permissions/web/src/generated`;
  private tables were skipped as intended.
- The configured Google client id is present in both module configuration and the web environment
  template. The consent-screen/origin setup is documented in `examples/permissions/README.md`.
- The UI uses `useTable(tables.publicSummary)` and `useTable(tables.privateSummary)`, binds all nine
  generated reducers through `createCommandClient`, and stores the Google credential for the
  connection builder via a reload after sign-in.
- The Phase 2 revision adds owner identity/email to the state read model and bootstraps zero-valued
  C1/C2/C3 rows on connect. The UI renders every public row: one themed C1 card plus one themed C2
  card per signed-in owner, showing the server-supplied owner email.
- C2 cards not owned by the current identity have their increment/decrement/reset buttons disabled;
  C3 and all C2 cards are hidden while signed out. The module still rejects unauthorized writes.
- The Google ID token and the anonymous SpacetimeDB connection token use separate localStorage keys.
  `App` checks only the Google credential, and `main.tsx` stores the connection token only while no
  Google credential is present. `clientConnected` recognizes that server-issued token as anonymous
  rather than rejecting it as a non-Google JWT, so C1 subscriptions and commands work while logged
  out, including after a reload.
- Bindings were regenerated after the read-model change with CLI 2.16.3; private tables remain
  skipped.
- Root scripts and `package-lock.json` include the new workspace; the example README was added to
  the package `files` list. No package source or public API signatures changed.

## Phase 3 verification

- `npm run example:permissions:test` passes: 18 module tests and 9 web tests.
- Module auth tests cover anonymous first connection, saved server-issued anonymous reconnect tokens,
  invalid issuer, invalid audience, missing subject, sender/JWT identity mismatch, and idempotent
  Google-identity bootstrapping of C2/C3 rows with the verified email.
- Module reducer tests cover anonymous C1 increment/decrement/reset, event ids and payloads, command
  id replay, invalid amounts and command ids, owner-only C2/C3 writes, issuer/audience rejection,
  the authoritative owner-row check, and isolation of identical command ids across users.
- Module view tests cover public C1/C2 rows with owner email and no C3 rows, per-caller C3 summary,
  public event access to C1/C2 only, and private event access to the caller's C3 only.
- Web command tests cover all nine generated reducer bindings, generated command ids, intent-only
  payloads, verbatim retry envelopes, and rejected-command propagation.
- Web token tests cover separate localStorage keys for Google ID and anonymous connection tokens,
  sign-out clearing both, first-use of the Google credential for the connection, and persistence of
  connection tokens only while signed out. Display-field decoding is also covered.
- Test-only support lives inside the example; no package source or public API signatures changed.

## Phase 4 verification

- `npm run example:permissions:test:integration` passes against a disposable local server: 4 live
  tests pass and the real-Google-token test is skipped unless explicitly supplied.
- The suite lives only in `examples/permissions/integration/` with its own Vitest config; it imports
  `stdb-es/testing/integration` and does not affect the framework-neutral browser entry points.
- Live checks cover anonymous C1 subscription reads, increment/decrement/reset, replayed command ids,
  public event projection, anonymous C2/C3 rejection, and saved server-issued token reuse.
- Saved server-issued tokens work for C1 but are rejected by owned C2/C3 reducers; an invalid token is
  also rejected by C1 without changing the value.
- The opt-in Google test requires `PERMISSIONS_GOOGLE_ID_TOKEN`, skips when `CI` is set, verifies
  C2 increment/decrement/reset with the server-supplied owner email, verifies C3 private-summary
  isolation, and confirms another identity cannot write the Google-owned C2 counter.
- `examples/permissions/README.md` documents both test commands, how to capture and use a fresh ID
  token, and that tokens must never be committed.
- No package source, public API, or generated binding changed in this phase.

## Current state

Phase 4 integration tests are ready for review. Phase 5 final consistency is next. No public API
signatures have changed.
