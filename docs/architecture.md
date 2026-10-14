# Architecture

## Browser connection

`npm start` attaches to everyday Chrome through Playwright's
`connectOverCDP('chrome', {noDefaults:true})`. Chrome 144+ must have remote debugging
enabled through its settings UI, and the user must approve the connection prompt.
The bridge discovers Chrome's local WebSocket endpoint through `DevToolsActivePort`.
`noDefaults` avoids Playwright's viewport, download, focus and media overrides.
Shutdown disconnects without closing Chrome or its tabs.

Serve configuration is validated once in `src/runtime/config.ts` before creating
a browser connection. `--bridge` overrides `FIDELITY_BRIDGE`; absence of both
selects `chrome-debugging`. `browser-attach` remains an alias. Empty and unknown
selections fail startup. Startup reports the selected mode and configuration source.

`FIDELITY_BRIDGE=browser` launches installed Chrome with a dedicated persistent
profile through a private debugging pipe. The profile stays under the private
runtime directory. Shutdown closes that Chrome instance. Both browser modes use
the same adapter and normalized MCP reads.

## Portfolio reads and authorization

The CLI starts a loopback HTTP server. MCP clients authorize through OAuth;
`BrowserBridge` selects or opens a portfolio tab and waits for sign-in and 2FA.
Once a working Fidelity session is confirmed, the server issues separate MCP
credentials to the client. Starting the server alone does not open Fidelity.

The build bundles `src/bridge/fidelity-api.ts` as `dist/bridge/browser-adapter.js`.
Only this fixed adapter runs in the portfolio page. It uses the signed-in page's
account context, runtime bootstrap configuration and internal Fidelity HTTP APIs.
All-account reads use visible supported person assets, independent of UI selection.
Cookies, CSRF tokens, raw request payloads and full account numbers stay in Chrome.

`PortfolioReader` validates inputs, response schemas, freshness and account scope;
it sums balance values in integer cents and formats normalized results. Reads are
serialized and recover to another portfolio tab if the selected tab closes.
Missing or expired sessions fail explicitly. SHA-256 of a process-lifetime random
salt and account number supplies opaque account references; restarting the server
changes them.

Automated E2E uses real headless Chromium with intercepted synthetic Fidelity HTTP.
Attach tests verify that disconnect preserves the browser and unrelated tabs.
They do not exercise Chrome's interactive approval UI or establish live Fidelity
compatibility. Manual live checks use the running server and produce sanitized
reports in `artifacts/`.

## Source layout

```text
src/
  index.ts          CLI entrypoint and application lifecycle
  server/           OAuth, loopback HTTP, and MCP tool registration
  bridge/           Browser connection, Fidelity adapter, and portfolio schemas
  domain/           Exact totals, page policy, and application errors
  runtime/          Local paths and startup configuration
scripts/            Build orchestration and optional live verification
tests/              E2E flows with synthetic Fidelity data
docs/               Architecture, security, and contributor instructions
```

`npm run build` produces `dist/index.js`, matching server subdirectories and the
bundled browser adapter. Browser-session handling stays in the bridge,
authorization and HTTP transport in the server, and normalized account contracts
in the domain. Each area uses direct imports.
