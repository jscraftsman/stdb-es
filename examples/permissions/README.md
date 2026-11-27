# Permissions example (M16)

A full-stack example that adds authentication and authorization to the event-sourced counter: one
Google-authenticated SpacetimeDB module and one React reference UI. The package itself stays
framework-neutral; React is confined to `web/`.

The example shows three counter rules:

| Counter | Read | Write | Instance rule |
| --- | --- | --- | --- |
| C1 — Global public | Everyone, including anonymous clients | Everyone, including anonymous clients | One app-wide stream |
| C2 — Public read, private write | Everyone | Google-authenticated owner only | One per Google user |
| C3 — Private read and write | Owner only | Owner only | One per Google user |

Authentication uses a Google ID token directly as the SpacetimeDB token. There is no SpacetimeAuth,
token-exchange server, client secret, or custom core API.

## Prerequisites

- Node.js 20+
- A local SpacetimeDB server already running on `http://127.0.0.1:3000`
- A Google account allowed by your OAuth consent screen

If the `local` server nickname is not configured:

```bash
spacetime server add local --url http://localhost:3000
```

## Google Cloud Console setup

This example is configured for the Web OAuth client ID:

```text
407348267584-b9dmdsvdbuiohlr5l459lbib0tkvbfed.apps.googleusercontent.com
```

To use your own project instead:

1. Open the [Google Cloud Console credentials page](https://console.cloud.google.com/apis/credentials)
   and create or select a project, for example `stdb-es-permissions-local`.
2. Open **APIs & Services → OAuth consent screen**. Choose **External** for a local demo. Fill in
   the application name, user support email, and developer contact email. Add `localhost` to
   **Authorized domains**. The default `openid`, `email`, and `profile` scopes are sufficient. While
   the app is in **Testing**, add your own Google account as a test user.
3. Return to **Credentials**, choose **Create credentials → OAuth client ID**, and select
   **Web application**. Name it something like `stdb-es-permissions-web`.
4. Under **Authorized JavaScript origins**, add both exact origins:
   - `http://localhost:5175`
   - `http://127.0.0.1:5175`

   Origins include scheme, host, and port, with no path or trailing slash. Popup mode needs no
   redirect URI.
5. Copy only the **Client ID**. Do not create or copy a client secret; the browser Sign In With
   Google flow uses the ID alone.
6. Put that client ID in `spacetimedb/src/domains/counter/config.ts` as `GOOGLE_CLIENT_ID` and in
   `web/.env.local` as `VITE_GOOGLE_CLIENT_ID`. `.env.local` is ignored by Git. See
   `web/.env.example` for the full template.
7. For deployment, add the HTTPS origin under **Authorized JavaScript origins** and the domain under
   **Authorized domains**. One Tap and silent refresh are out of scope.

## Run it

From the repository root:

```bash
npm install
npm run example:permissions:start
```

That command:

1. builds the `stdb-es` package;
2. builds the module in `spacetimedb/`;
3. generates TypeScript bindings into `web/src/generated`;
4. typechecks both subprojects;
5. publishes to `stdb-es-permissions` on the local server, preserving existing data;
6. starts Vite on `http://127.0.0.1:5175`.

Use `npm run example:permissions:publish` to build and publish without starting Vite. Use
`npm run example:permissions:publish-clean` only when you deliberately want to reset the scratch
database. After the first publish, start only the UI with:

```bash
npm --prefix examples/permissions/web run dev
```

Web environment overrides: `VITE_STDB_URI` (default `ws://localhost:3000`),
`VITE_STDB_DATABASE` (default `stdb-es-permissions`), and `VITE_GOOGLE_CLIENT_ID` (defaults to the
configured client id above).

## Try the authorization matrix

- Before signing in, only the C1 card is visible. Increment, decrement, or reset it anonymously.
  The Google ID token is stored separately from SpacetimeDB's anonymous connection token, so having
  a connection token does not make the UI think you are signed in. That server-issued token is also
  accepted on reconnect as an anonymous identity instead of being rejected as a non-Google JWT.
- Click the Google button. The GIS callback stores the ID token and reloads the page, so the
  SpacetimeDB connection is rebuilt with that token.
- Your C2 and C3 cards appear with a zero value: `clientConnected` creates one owned row of each
  kind from the verified `ctx.sender` before your first command.
- Every signed-in browser lists one C2 card per authenticated owner, with that owner's email from the
  server. Cards owned by other accounts are read-only in the UI; the module also rejects their write
  reducers.
- C3 appears only in the current user's private summary. Another Google account cannot read or write
  the first account's C3 stream.
- Sign out to hide C2 and C3, clear the saved token, and return to anonymous access. C1 remains
  available and writable. C1, C2, and C3 use blue, green, and purple accents respectively while
  sharing the same controls.

Google ID tokens expire after about an hour. A long-lived connection keeps its established identity
until reconnection; sign in again and reload to get a fresh token. The example does not implement
silent refresh.

## What it demonstrates

- Three authorization levels in one module: public read/write, public read with owner-only write,
  and owner-only read/write.
- Direct Google OIDC ID tokens passed to `DbConnection.builder().withToken(...)`, stored separately
  from anonymous SpacetimeDB connection tokens so C1 stays usable while logged out.
- Module-side issuer, audience, subject, and sender-identity checks. SpacetimeDB verifies the token
  signature and derives identity from `iss` + `sub`, but it does not check `aud`.
- `clientConnected` allows anonymous connections and saved anonymous reconnect tokens, and rejects
  other non-Google supplied tokens.
- Deterministic, stream-scoped stream ids so callers cannot choose or duplicate owned counters.
- Intent-only reducers: the browser sends `by` and `commandId`, never an event or stream id.
- A public anonymous view that lists C1 and every C2 row with server-stamped owner identity/email, a
  per-caller private view, and two parameterized event views whose `authorize` callbacks enforce
  stream type and ownership.
- Read-model rows created on connect so the visible C2 card count matches the number of authenticated
  users rather than the number who have already sent a command.
- Committed CLI 2.16.3 bindings; the UI imports command payload types from
  `web/src/generated/types/reducers.ts`.

## Layout

```text
permissions/
  spacetime.json
  spacetimedb/
    src/
      index.ts                       # module exports only
      schema.ts                      # esTables + state (with owner metadata) + owner tables
      domains/counter/
        config.ts                    # Google issuer and configured client id
        auth.ts                      # ID-token claim checks + display email
        streams.ts                   # global and sender-derived stream ids
        aggregate.ts
        constants.ts
        events.ts
        reducers.ts                  # nine command reducers + clientConnected bootstrap
        views.ts                     # public/private state and event views
  web/
    src/
      main.tsx                       # SpacetimeDBProvider with saved token
      App.tsx                        # connection status + public counter list + private card
      auth/                          # GIS button, sign-out, display-only token decode
      domains/counter/               # generated command client binding + reference UI
      generated/                     # regenerated by the publish script
```

## Out of scope

No SpacetimeAuth, no server-side token exchange, no client secret, no silent refresh, no One Tap,
no framework code in `stdb-es`, and no new public package API. The event views are available to the
integration kit; this UI reads materialized state views only.
