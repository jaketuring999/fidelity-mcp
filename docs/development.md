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

Run `MCP_PORT=3444 npm run dev` after an initial build to generate the browser
adapter. `npm start` rebuilds and runs the compiled server using Chrome debugging
by default. See [setup](setup.md#chrome-remote-debugging-setup) for Chrome's setting
and approval prompt.

`check` type-checks all runtime source, including the browser adapter. `test`
builds the app and runs only E2E tests.

## Code style

ESLint uses the recommended JavaScript and TypeScript rules for the server,
browser adapter, scripts, and E2E tests. Prettier formats authored files with single
quotes and a 100-column target, expanding dense objects and statements into
consistent layouts. Saved Fidelity reference material and generated files are
excluded. CI requires both lint and formatting checks to pass.

```sh
npm run lint:fix   # Fix automatically correctable lint issues.
npm run format     # Apply formatting throughout the authored project.
```

## Verification

| Suite       | Coverage                                                                                                                                                         | Evidence                                                          |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| OAuth E2E   | Real Chromium CDP connection, bundled adapter, loopback HTTP, official MCP SDK, discovery, PKCE, callback policy, balance calls, refresh, restart and revocation | `artifacts/oauth-e2e.json`                                        |
| Browser E2E | Six tools in real Chromium, owned and attached browser modes, account scope, precision, gzip/bootstrap, masking, failures and tab recovery                       | `artifacts/browser-e2e.json`, `artifacts/browser-attach-e2e.json` |
| Package E2E | Actual tarball, Git publication inventory, sensitive-file guards, bundled adapter and extracted CLI                                                              | `artifacts/package-e2e.json`                                      |

The compiled CLI startup E2E runs with an isolated home and no Chrome debugging endpoint. It verifies failing default and explicit `--bridge chrome-debugging` startup exits with setup instructions and writes `artifacts/browser-startup-e2e.json`, without connecting to the user browser.

The automated suites use synthetic Fidelity data. They do not establish compatibility with a live Fidelity session. The browser E2E suite uses real headless Chromium with intercepted synthetic HTTP and writes `artifacts/browser-e2e.json`. Install test Chromium with the command above; production browser mode uses installed Google Chrome. The package test uses the checkout's installed dependencies to run the extracted build. Evidence includes repeat commands and is generated only after the relevant assertions pass; check timestamps and the current test exit status when reviewing local reports.

Git ignores `artifacts/`, `dist/`, `.cursor/`, package tarballs, dependencies, runtime state, and downloaded Fidelity discovery evidence. These are local output or configuration, not source. CI uploads successful E2E reports as downloadable run artifacts.

## Live verification

With the server running, run `MCP_PORT=3444 npm run check:live` (using your
server's actual port). The check uses the existing browser connection and writes
`artifacts/browser-attach-live.json`. For the dedicated-profile mode, set
`FIDELITY_BRIDGE=browser` on both commands to write `artifacts/browser-live.json`.

The check follows local OAuth redirects automatically; sign in to Fidelity in
Chrome if prompted. It lists accounts, reads balances and positions, checks
performance and all four history ranges for all and every single account, reads
tax lots for every held symbol, validates schemas and refresh rotation, and revokes
its test grant. Reports omit credentials and financial values. Live checks are
manual and outside CI. Keep one server running between checks to reuse its Chrome
connection; a new server process may require another Chrome approval.

## Packaging

```sh
npm pack
```

The prepack hook checks types and builds. An explicit package allowlist includes runtime JavaScript, the bundled browser adapter, README, and the curated documentation. It excludes tests, scripts, downloaded provider code, source maps, declarations, local MCP configuration, and verification reports. The package E2E checks the actual tarball and Git publication candidates for unsafe files. The package remains private.

The compiled CLI supports `serve` and `revoke-access`.

Use E2E coverage for changes crossing the client, server and browser. Exercise
financial normalization and provider failures through the portfolio flow, and
emit sanitized, repeatable evidence after assertions pass.
