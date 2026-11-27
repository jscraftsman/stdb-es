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
- A public anonymous view exposes C1 and C2 rows.
- A per-caller view exposes only the caller's C3 row.
- A public parameterized event view allows only C1 and C2 streams.
- A separate per-caller parameterized event view allows only the caller's C3 stream.
- No view exposes all event streams.

### Write authorization plan

- C1: no JWT requirement; any sender may increment, decrement, or reset the one global stream.
- C2/C3: require a JWT whose issuer is Google and whose audience contains the configured Google
  OAuth client ID. SpacetimeDB derives the identity from `iss` + `sub`; the stream id is deterministic
  from counter type plus that identity, so one user cannot create a second instance by choosing a
  different id.
- `clientConnected` allows anonymous connections so C1 and C2 reads remain public. If a JWT is
  present, it must be a Google ID token for the configured client ID.
- Reducers still check the owner row with `.equals(ctx.sender)` before appending. A rejected command
  writes no event and no cache row.
- Google ID tokens expire after about an hour. The example documents that a long-lived connection
  keeps its identity until reconnection, and that signing in again produces a fresh token for a new
  connection.

## Google Cloud Console setup

This is the setup guide the example README will carry. It uses the Sign In With Google button in
popup mode and needs no redirect URI or client secret.

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

- The example accepts only Google ID tokens, with `https://accounts.google.com` as the expected
  issuer and the configured OAuth client ID in `aud`. SpacetimeDB does not check `aud`, so the module
  must.
- Anonymous connections are allowed; otherwise the public C1 write/read case could not be shown.
  Anonymous callers still fail C2/C3 write authorization.
- Counter ids are not trusted for owned counters. The module derives their streams from the verified
  sender identity and counter type.
- Unit tests use `TestAuth.fromJwtPayload` to cover Google-valid and invalid claim cases offline.
- Automated live integration tests require no Google credentials: they cover C1 writes and C2/C3
  rejection using CLI identities. An opt-in live check with real Google ID tokens covers the positive
  authenticated path and private-view isolation; it is skipped in CI.

## Phases

- [x] Phase 0 — Planning: create this M16 record, link it from the design record, and agree on the
      counter contract, Google setup flow, and phase boundaries.
- [ ] Phase 1 — Backend module: add `examples/permissions/spacetimedb/` with the schema, auth
      helpers, command reducers, public/private views, and module configuration. No tests yet.
- [ ] Phase 2 — Full-stack wiring: add the React client, Google sign-in flow, generated bindings,
      root npm scripts/workspaces/lockfile, and the example README with the Google Console guide.
- [ ] Phase 3 — Unit tests: add module harness tests for issuer/audience validation, C1/C2/C3 write
      rules, idempotency, and view isolation, plus client tests for command payloads and token
      handling.
- [ ] Phase 4 — Integration tests: add a separate Node-only suite for the live authorization matrix,
      including the opt-in real-Google-token check.
- [ ] Phase 5 — Final consistency: add CI gates and docs links, run the full verification set, and
      close this record as `completed`.

## Phase 0 verification

- No package source or public API was changed.
- The design record now links this active M16 record and lists M16 as a planned example set.
- Google authentication is designed around direct OIDC ID tokens, with module-side issuer and
  audience checks; no SpacetimeAuth dependency is introduced.

## Current state

Phase 0 is complete. Phase 1 is next. No public API signatures have changed.
