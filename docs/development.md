# Development

Run commands from the repository root with Node.js 22.13 or newer:

```sh
npm ci
npm run lint
npm run format:check
npm run check
npm test
```

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

For formatting on save, install your editor's Prettier extension and select it
as the default formatter. The ESLint extension can also show lint findings as
you edit. Both use this repository's configuration and local dependencies.

Explicit `any` is allowed only in the dynamic Fidelity browser adapter and E2E
fixtures; application code retains the recommended rule against it. Unused
properties deliberately removed with object rest syntax are allowed. The HTTP
listener's deferred OAuth initialization has one documented local exemption
from `prefer-const`.

## Verification

| Suite         | Coverage                                                                                                                                                                                                   | Evidence                            |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| OAuth E2E     | Loopback HTTP, real compiled native-host subprocess, official MCP SDK, discovery, PKCE, callback policy, balance calls, refresh, restart, and revocation                                                   | `artifacts/oauth-e2e.json`          |
| Extension E2E | Built Chrome worker under simulated Chrome APIs; same-tab sign-in, readiness proof, and subsequent balance read                                                                                            | `artifacts/extension-flow-e2e.json` |
| Portfolio E2E | Three MCP tools, real native host, built worker and serialized adapter under simulated Chrome; account filters, collision-safe references, precision, cash semantics, gzip/bootstrap, masking and failures | `artifacts/portfolio-e2e.json`      |
| Package E2E   | Actual tarball and Git publication inventory, sensitive-file guards, extracted CLI, extension assets, and native registration in an isolated home                                                          | `artifacts/package-e2e.json`        |

The automated suites use synthetic Fidelity data. They do not establish compatibility with a live Fidelity session or exercise a real Chrome UI. The package test uses the checkout's installed dependencies to run the extracted build. Evidence includes repeat commands and is generated only after the relevant assertions pass; check timestamps and the current test exit status when reviewing local reports.

Git ignores `artifacts/`, `dist/`, `.cursor/`, package tarballs, dependencies, runtime state, and downloaded Fidelity discovery evidence. These are local output or configuration, not source. CI uploads successful E2E reports as downloadable run artifacts. Keep the build and live-check scripts: they are the supported reproducible workflows, not historical scratch files.

## Live verification

With the server running and the unpacked extension loaded:

```sh
npm run check:live
# Follow local redirects automatically:
npm run check:live -- --automatic
```

The interactive check prints an authorization URL to open in Chrome. Sign in to Fidelity if prompted. It lists real accounts, reads balances and positions for all accounts and one account, verifies refresh rotation, revokes its test grant, and writes `artifacts/oauth-live.json` without credentials or financial values. `FIDELITY_MCP_URL` selects a different local endpoint. Live checks are manual and are outside CI.

## Packaging

```sh
npm pack
```

The prepack hook checks types and builds. An explicit package allowlist includes runtime JavaScript, extension assets, README, and the curated documentation. It excludes tests, scripts, downloaded provider code, source maps, declarations, local MCP configuration, and verification reports. The package E2E checks the actual tarball and Git publication candidates for unsafe files. The package remains private.

The compiled CLI supports `setup [extension-id]`, `extension-path`, `serve`, and `revoke-access`. Keep the extracted or installed package at a stable location; native registration points at its CLI and Node executable. Rerun setup after relocating either, and reload the unpacked extension after each rebuild.

Use E2E coverage for changes crossing the client, server, native bridge, and extension. Exercise financial normalization and provider failure handling through the portfolio flow. Emit sanitized, repeatable evidence after assertions pass.
