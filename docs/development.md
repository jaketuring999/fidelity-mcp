# Development

Run commands from the repository root with Node.js 24.0 or newer:

```sh
npm ci
npm run lint
npm run format:check
npm run check
npx playwright install --with-deps chromium
npm test
```

For current remote-debugging development, run `MCP_PORT=3444 npm run dev:debugging`
after an initial build. Use `npm run start:debugging` to rebuild and run the compiled
server, or `npm run start:extension` to select the extension. Stop the current server
before switching. See the README for the Chrome setting and approval prompt.

`check` type-checks the server and extension. `test` builds the app and runs only E2E tests. `npm run dev` runs the server source with tsx; build and load the extension separately.

## Code style

ESLint uses the recommended JavaScript and TypeScript rules for the server,
extension, scripts, and E2E tests. Prettier formats authored files with single
quotes and a 100-column target, expanding dense objects and statements into
consistent layouts. Saved Fidelity reference material and generated files are
excluded. CI requires both lint and formatting checks to pass.

```sh
npm run lint:fix   # Fix automatically correctable lint issues.
npm run format     # Apply formatting throughout the authored project.
```

## Verification

| Suite         | Coverage                                                                                                                                                                                                                                             | Evidence                       |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| OAuth E2E     | Loopback HTTP, real compiled native-host subprocess, official MCP SDK, discovery, PKCE, callback policy, balance calls, refresh, restart, and revocation                                                                                             | `artifacts/oauth-e2e.json`     |
| Portfolio E2E | Six MCP tools, real native host, built worker and serialized adapter under simulated Chrome; automatic connection, sign-in/tab recovery, account filters, collision-safe references, precision, cash semantics, gzip/bootstrap, masking and failures | `artifacts/portfolio-e2e.json` |
| Package E2E   | Actual tarball and Git publication inventory, sensitive-file guards, extracted CLI, extension assets, and native registration in an isolated home                                                                                                    | `artifacts/package-e2e.json`   |

The compiled CLI startup E2E runs with an isolated home and no Chrome debugging endpoint. It verifies a failing `--bridge chrome-debugging` startup exits with setup instructions and writes `artifacts/browser-startup-e2e.json`, without connecting to the user browser.

The automated suites use synthetic Fidelity data. They do not establish compatibility with a live Fidelity session. The browser E2E suite uses real headless Chromium with intercepted synthetic HTTP and writes `artifacts/browser-e2e.json`; other suites simulate Chrome. Install test Chromium with the command above; production browser mode uses installed Google Chrome. The package test uses the checkout's installed dependencies to run the extracted build. Evidence includes repeat commands and is generated only after the relevant assertions pass; check timestamps and the current test exit status when reviewing local reports.

Git ignores `artifacts/`, `dist/`, `.cursor/`, package tarballs, dependencies, runtime state, and downloaded Fidelity discovery evidence. These are local output or configuration, not source. CI uploads successful E2E reports as downloadable run artifacts.

## Live verification

For everyday Chrome attachment, run the server with
`FIDELITY_BRIDGE=browser-attach MCP_PORT=3444`, enable remote debugging in your
running Chrome, and approve its connection prompt. Run
`FIDELITY_BRIDGE=browser-attach MCP_PORT=3444 npm run check:live` for a sanitized
report at `artifacts/browser-attach-live.json`. Synthetic attach coverage writes
`artifacts/browser-attach-e2e.json` and includes preservation of the existing
browser and unrelated tabs on disconnect.

With the server running and the unpacked extension loaded:

For the extension-free prototype, start the server with `FIDELITY_BRIDGE=browser`
instead; the same live check below works against its OAuth/MCP endpoint. Sign in
in the dedicated Chrome window. It does not reuse your ordinary Chrome profile.
Set `FIDELITY_BRIDGE=browser` on the live-check command as well to write the
sanitized evidence to `artifacts/browser-live.json`.

```sh
npm run check:live
```

The check follows local OAuth redirects automatically; sign in to Fidelity in Chrome if prompted. It lists real accounts, reads balances/positions, checks performance for all and every single account, checks all four balance-history ranges for those scopes, reads tax lots for every held symbol, verifies canonical result schemas and refresh rotation, revokes its test grant, and writes `artifacts/oauth-live.json` without credentials or financial values. `MCP_PORT` selects the same loopback port as the server. Live checks are manual and are outside CI. This command uses the running server and does not create a Chrome debugging connection. Keep that server running between checks to avoid new Chrome approval prompts. Repeated `BrowserBridge.start()` calls reuse the same connection, including concurrent startup. Chrome can still require approval when a new server process attaches.

## Packaging

```sh
npm pack
```

The prepack hook checks types and builds. An explicit package allowlist includes runtime JavaScript, extension assets, README, and the curated documentation. It excludes tests, scripts, downloaded provider code, source maps, declarations, local MCP configuration, and verification reports. The package E2E checks the actual tarball and Git publication candidates for unsafe files. The package remains private.

The compiled CLI supports `setup`, `serve`, and `revoke-access`. Keep the extracted or installed package at a stable location; native registration points at its CLI and Node executable. Rerun setup after relocating either, and reload the unpacked extension after each rebuild.

Use E2E coverage for changes crossing the client, server, native bridge, and extension. Exercise financial normalization and provider failure handling through the portfolio flow. Emit sanitized, repeatable evidence after assertions pass.
