# Architecture

## Experimental browser transport

The startup selector `--bridge chrome-debugging` (or `npm run start:debugging`)
chooses everyday Chrome attachment; `--bridge extension` chooses the companion
extension. The CLI selection overrides `FIDELITY_BRIDGE`. The existing
`browser-attach` environment value remains an alias for everyday Chrome mode.
Switching requires restarting the server; the MCP tools and URL stay the same.

`FIDELITY_BRIDGE=browser-attach` connects to the user's running default Chrome
profile through Playwright's `connectOverCDP('chrome', {noDefaults:true})`.
Chrome 144+ must have remote debugging enabled through its settings UI, and
the user must approve the connection prompt. The bridge discovers the local
endpoint through Chrome's `DevToolsActivePort` mechanism; it does not export
cookies or launch another browser. The attach connection uses Chrome's local
WebSocket endpoint rather than the owned-browser pipe. `noDefaults` avoids
Playwright's default viewport, download, focus and media overrides. Shutdown
disconnects the CDP browser connection without closing Chrome or its tabs.

Both transports inherit `PortfolioReader`, which owns account-reference input
validation, response schemas, freshness and account-scope checks, exact balance
totals, and positions result formatting. Provider failures use shared messages.
`ExtensionBridge` supplies snapshots through native messaging; `BrowserBridge`
supplies them through serialized CDP evaluations. Connection, tab selection,
readiness and shutdown remain specific to each transport.

The adapter and normalized MCP reads are identical in both browser modes.
Automated attach E2E uses a separate synthetic browser with a CDP endpoint;
it verifies reads and that shutdown preserves the browser and unrelated tabs.
That does not exercise Chrome's interactive approval UI or establish live
Fidelity compatibility; the live attach check writes `artifacts/browser-attach-live.json`.

`FIDELITY_BRIDGE=browser` selects `BrowserBridge` instead of `ExtensionBridge`.
Playwright launches installed Chrome with a dedicated persistent profile and
communicates over its private debugging pipe; no debugging TCP port, extension,
native-host registration or bridge socket is used. The profile stays under the
private runtime directory. Browser-mode shutdown closes that Chrome instance.

The build bundles the existing Fidelity adapter separately. Only that fixed
adapter runs in the portfolio page; the local MCP interface still accepts only
the three normalized portfolio reads. Cookies, CSRF tokens and full account
numbers remain in Chrome. The server retains an account-reference salt for the
process lifetime, so restarting browser mode changes the references. Reads are
serialized, validated for schema, freshness and account scope, and recover to
another portfolio tab if the selected tab closes. Authorization opens a portfolio
tab and waits for sign-in/2FA readiness. Missing or expired sessions fail explicitly.

This removes the extension installation requirement but retains the signed-in
Fidelity page context. Standalone GraphQL account discovery and browser-free
HTTP authentication are not implemented. Live provider compatibility for this
transport requires a separate manual check.

## Extension transport

The CLI starts a loopback HTTP server and an authenticated private socket. MCP clients authorize through the HTTP server. The Chrome extension connects through Chrome native messaging; a native-host subprocess forwards fixed operations between the extension and the private socket.

For authorization, the server asks the extension to establish Fidelity readiness. The extension selects or opens a Fidelity portfolio tab and waits through sign-in and 2FA. It returns a connection proof containing `connected: true`. The server then issues separate MCP credentials to the client.

For portfolio reads, the MCP tools send fixed `list_accounts`, `read_balance` and `read_positions` operations through the bridge. The extension executes the Fidelity adapter in the selected tab's MAIN world, reads its account context, and calls `POST /ftgw/digital/balwebex/api/balances`. Bootstrap configuration can be fetched as text without executing its scripts. The positions adapter uses `POST /ftgw/digital/positions/poswebex/api/positions` with a gzip `pico` envelope and an explicit account list. All-account reads use visible supported person assets, independent of UI selection. The worker retains a random salt in Chrome session storage; SHA-256 of salt and account number supplies opaque references shared by all three tools. Normalized, masked portfolio data returns through the bridge; the server validates account scope and sums balance values in integer cents.

## Source layout

```text
src/
  index.ts          CLI entrypoint and application lifecycle
  server/           OAuth, loopback HTTP, and MCP tool registration
  bridge/           Private socket, native host, and framed message schemas
  domain/           Balance contracts, exact totals, and application errors
  runtime/          Local paths, Chrome launch, and setup
extension/
  src/              Chrome worker and Fidelity API adapter
  assets/           Chrome extension manifest
scripts/            Build orchestration and optional live verification
tests/             E2E flows with synthetic Fidelity data
docs/              Architecture, security, and contributor instructions
```

`npm run build` produces `dist/index.js`, matching server subdirectories, and a bundled `dist/extension/`. The runtime setup module locates the extension and CLI relative to that compiled layout. The manifest's public key gives the unpacked extension a stable ID; it is public configuration, not a secret.

Keep browser-session handling in the extension, native framing and socket handling in the bridge, authorization and transport in the server, and normalized account contracts in the domain. Each area has direct imports; there are no barrel modules or separate workspace packages to maintain.
