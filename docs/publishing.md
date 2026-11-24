# Publishing `stdb-es` to npm

Releases are **manual**. Pushing or merging to `master` only runs CI; it never publishes to npm.
Publication happens through the **Publish to npm** GitHub Actions workflow (`.github/workflows/publish.yml`),
which you start from the Actions tab. The default action is `dry-run`; a real publish requires you to
select `publish` explicitly.

## One-time setup (manual)

1. **Confirm npm access.** `stdb-es` already exists on npm. Use an npm account that can publish that
   package.
2. **Create the GitHub environment.** In the repository, go to **Settings → Environments** and create
   `npm-publish`. Add required reviewers if you want a second approval after starting the workflow.
3. **Set up authentication.**
   - **Recommended: npm trusted publishing (OIDC).** On npmjs.com, open the `stdb-es` package's
     **Settings → Trusted publishing** page and add a GitHub Actions publisher:
     - Organization/user: `jscraftsman`
     - Repository: `stdb-es`
     - Workflow filename: `publish.yml`
     - Environment name: `npm-publish`
     - Allowed actions: select **`npm publish`**

     The workflow requests `id-token: write` and needs no long-lived token when OIDC is configured.
     npm generates provenance automatically for public repositories. A new trusted publisher must
     complete one successful publish within **2 days** or it expires.
   - **Fallback: granular access token.** If OIDC is not configured yet, on npmjs.com open
     **Access Tokens → Generate New Token** and create a **granular access token**:
     - Permission: **Read and write (publish and stage)**
     - Packages and scopes: select the existing `stdb-es` package
     - Check **Bypass two-factor authentication** so GitHub Actions can publish non-interactively
     - Use a short expiration, for example 90 days

     Copy the token when it is displayed and add it as the GitHub repository secret `NPM_TOKEN`.

   **Important:** the workflow prefers `NPM_TOKEN` whenever that secret exists. After configuring
   trusted publishing, **delete the `NPM_TOKEN` repository secret** before the next publish so OIDC
   is actually exercised. Once an OIDC publish succeeds, revoke the npm token and, in the package's
   **Publishing access** settings, choose to disallow tokens.
4. **Keep `master` as the default branch.** Runs started from any other branch are skipped, and the
   job also contains an in-step branch guard. The `repository.url` in `package.json` must continue to
   point at `https://github.com/jscraftsman/stdb-es.git`.

The workflow uses `NPM_TOKEN` when the secret exists; otherwise it relies on trusted publishing.

## Release steps (manual)

1. Bump the version and keep the README status line in sync:

   ```bash
   npm version patch    # or minor / major / prerelease
   # update the status line in README.md
   git push origin master --follow-tags
   ```

2. Wait for the normal **CI** workflow on `master` to pass.
3. Open **Actions → Publish to npm → Run workflow** and choose:
   - **Action:** `dry-run` (default) to run every check and `npm publish --dry-run`, or `publish` to
     actually publish.
   - **Tag:** `latest` for a stable release, `next` or `beta` for a pre-release.
   - **Expected version:** optionally type the exact version from `package.json`. The workflow fails
     if it does not match.
4. Review the run. If you configured required reviewers on the `npm-publish` environment, approve the
   `publish` job when GitHub asks.
5. Verify the result:

   ```bash
   npm view stdb-es version
   npm view stdb-es dist-tags --json
   ```

## What the publish workflow checks

The workflow uses Node `24.22.3` and `actions/checkout@v6` / `actions/setup-node@v6`. It verifies that
npm is at least `11.5.1` (required for trusted publishing), then runs:

- branch, action, dist-tag, and optional version guards
- `npm ci` from the committed lockfile
- build, library typecheck, and the React counter typecheck (module and web)
- offline unit tests
- fresh-workspace `npm pack` install (`npm run check:pack`)
- `npm pack --dry-run` to show the exact tarball contents
- `npm publish --dry-run` or `npm publish` with `--access public` and the selected dist-tag

Before release, confirm `package.json` still declares `spacetimedb` and `vitest` as **required** peers
and that no React, Phaser, or other UI framework dependency was added to the package. The offline
suite includes frontend-neutrality guards, and `npm pack --dry-run` must show no framework runtime in
the tarball.

The tarball contains `dist`, `README.md`, `LICENSE`, `docs`, and the React counter README. It does not
contain tests, fixtures, editor files, or example source code.

## If a publish fails

- Fix the cause, make a new version bump, and start the workflow again. npm versions are immutable;
  you cannot republish the same version.
- `ENEEDAUTH` usually means the trusted-publisher fields do not exactly match the repository,
  workflow filename, or environment name, that the `npm publish` allowed action was not selected, or
  that `NPM_TOKEN` is missing when OIDC is not configured.
- A failed dry run leaves the registry untouched.
