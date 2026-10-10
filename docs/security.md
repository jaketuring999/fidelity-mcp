# Security and authorization

Fidelity MCP trusts the current OS user and local MCP clients. When the authenticated extension confirms a working Fidelity session, the server automatically grants a connecting client portfolio read access. There is no per-client approval UI or per-call confirmation. One server per OS user shares that user's selected Fidelity session with authorized clients.

The server listens only on `127.0.0.1`, rejects foreign Host/Origin values, and disables cross-origin browser access. Transport is stateless Streamable HTTP. OAuth records persist separately from MCP transport state.

Better Auth's MCP and CIMD plugins supply discovery, PKCE S256, signed resource-bound access tokens, rotating refresh tokens, and client metadata support. Dynamic registration supports compatible clients. Allowed redirects are loopback HTTP/HTTPS and Cursor's exact `https://www.cursor.com/agents/mcp/oauth/callback` URL. Access tokens last 15 minutes; refresh grants and owner sessions last up to 30 days.

Connection initiation, dynamic registration, authorization, token exchange, and revocation have per-route request limits stored in the local auth database, so restarting the server does not reset them. MCP and registration JSON bodies must be objects with nesting limited to 64 levels; HTTP request bodies are capped at 64 KiB. CI runs `npm audit` against the lockfile and current advisory database.

The local listener uses HTTP. Treat it as a local development deployment: production MCP authorization requires HTTPS. Remote hosting requires trusted HTTPS and a separate authorization policy.

## Data boundary

- Sign-in, saved-password autofill, cookies, CSRF headers, full account numbers, and Fidelity request payloads stay inside Chrome.
- The extension has host access to `https://digital.fidelity.com/*` and exposes fixed readiness, account listing, balance and positions operations, without an arbitrary URL or script gateway.
- Native messaging and the authenticated private socket carry normalized account metadata, balances, positions and connection proof. Account names and values still constitute sensitive financial data.
- Public HTTP requests cannot create owner sessions or submit consent directly. Owner cookies remain inside the server process.
- Authorization records, signing keys, the server secret, and native-bridge state live under `~/.fidelity-mcp/`, with private runtime directory and credential-file permissions.

To revoke every local client's access and refresh grants:

```sh
node dist/index.js revoke-access
```

Clients must reconnect afterward. Fidelity session expiry separately requires signing in again in Chrome.

Do not commit runtime state, captured provider responses, credentials, or financial data. Generated verification reports and local editor/client configuration are ignored by Git and excluded from the package.

The portfolio scope is `fidelity:portfolio:read`. Existing balance-only tokens do not authorize the new tool set; reconnect local clients after upgrading. The extension retains a browser-session salt for opaque account references. Full account numbers and raw provider context still remain in Chrome. All-account reads cover supported visible brokerage accounts regardless of the currently highlighted account.

## Public repository hygiene

The public repository contains runtime source, E2E tests using synthetic data, and curated API contracts. Downloaded Fidelity bundles, extracted GraphQL documents and discovery indexes stay local and are ignored by Git. Packaging uses an explicit allowlist so ignored research cannot leak into a tarball. Database files, environment files, private-key containers and HAR captures are ignored as well. An ignore rule is not a secret detector: review new fixtures and documentation before committing, and never force-add local research or runtime data.

`npm test` verifies the actual package contents and scans Git publication candidates for common credential patterns, local paths and forbidden runtime/research files. Its sanitized report records file hashes for review. This is a publication guard, not a complete security audit.
