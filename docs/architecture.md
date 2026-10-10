# Architecture

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
  runtime/          Local paths, configuration, Chrome launch, and setup
extension/
  src/              Chrome worker, popup controller, and Fidelity API adapter
  assets/           Manifest and popup HTML/CSS
scripts/            Build orchestration and optional live verification
tests/             E2E flows with synthetic Fidelity data
docs/              Architecture, security, and contributor instructions
```

`npm run build` produces `dist/index.js`, matching server subdirectories, and a bundled `dist/extension/`. The runtime setup module locates the extension and CLI relative to that compiled layout. The manifest's public key gives the unpacked extension a stable ID; it is public configuration, not a secret.

Keep browser-session handling in the extension, native framing and socket handling in the bridge, authorization and transport in the server, and normalized account contracts in the domain. Each area has direct imports; there are no barrel modules or separate workspace packages to maintain.
