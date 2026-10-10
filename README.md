# Fidelity MCP

Read Fidelity accounts, balances, and positions from a local MCP client using your existing Chrome session. Fidelity MCP runs on your computer and includes a companion Chrome extension. This is an unofficial integration with three read-only tools: `fidelity_list_accounts`, `fidelity_get_account_balance`, and `fidelity_get_positions`.

List accounts first, then use the returned opaque `accountId` to read one account's balance or positions. Omit `accountId` to read all visible supported Fidelity brokerage accounts, including brokerage IRAs, regardless of the account highlighted in Chrome. Hidden accounts, external accounts, and other account types are excluded. Account numbers are masked. Orders and transfers are outside the app's scope.

For tool development, start with the [offline Fidelity API reference](docs/fidelity/README.md): an endpoint catalog, synthetic examples, and reconstructed OpenAPI contracts for validated reads. Downloaded bundles and client GraphQL documents are local research evidence excluded from publication.

## Requirements

- Node.js 24.0 or newer and npm.
- Google Chrome 120 or newer on macOS or Linux.
- A local MCP client with Streamable HTTP, OAuth discovery, and a supported callback: loopback HTTP/HTTPS or Cursor's exact `https://www.cursor.com/agents/mcp/oauth/callback` URL.

The server binds to `127.0.0.1`. A cloud client cannot reach this address. Native-host setup supports macOS and Linux.

## Setup

From the repository root:

```sh
npm ci
npm run setup
```

1. Open `chrome://extensions`, enable **Developer mode**, select **Load unpacked**, and choose the printed `dist/extension` directory.
2. Run `npm start` and leave the server running. The extension connects automatically.
3. Add the server URL to your MCP client's configuration:

```json
{
  "mcpServers": {
    "fidelity": {
      "url": "http://127.0.0.1:3443/mcp"
    }
  }
}
```

4. Connect from your client. Authorization opens or focuses Fidelity in Chrome. Sign in and complete 2FA directly in Fidelity if prompted. The extension waits for that tab to be ready, and authorization returns to the client automatically.

Local clients receive portfolio read access when the extension confirms a working Fidelity session. There is no client approval step. The client stores and refreshes its own MCP tokens; Fidelity credentials, cookies, and 2FA codes stay in Chrome. See [security and authorization](docs/security.md) for the trust boundary.

The extension has no popup or manual controls. It reuses the tab chosen during authorization while that tab remains available. Otherwise it chooses an active Fidelity tab, then the most recently used one, or opens Fidelity during authorization if none exists. Portfolio calls reuse the session without navigating.

Setup writes native-host registration for the current OS user. Runtime state lives under `~/.fidelity-mcp/`. Keep this checkout at a stable path, and rerun setup after moving it or changing Node. Reload the unpacked extension after rebuilding. Ctrl+C stops the server and leaves Chrome open.

## Commands and configuration

| Command                            | Purpose                                         |
| ---------------------------------- | ----------------------------------------------- |
| `npm run setup`                    | Build and register the Chrome native host.      |
| `npm start`                        | Build and run the local server.                 |
| `node dist/index.js serve`         | Run an existing build.                          |
| `node dist/index.js revoke-access` | Revoke all local MCP access and refresh grants. |

After revocation, clients must reconnect. An expired Fidelity session returns `AUTHENTICATION_REQUIRED`; sign in again in Chrome to resume portfolio reads.

| Variable   | Default | Purpose                                                                       |
| ---------- | ------- | ----------------------------------------------------------------------------- |
| `MCP_PORT` | `3443`  | Loopback HTTP port, from 1 to 65535. Update your client URL when changing it. |

## Tools and account selection

| Tool                           | Parameters                          | Result                                                                               |
| ------------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------ |
| `fidelity_list_accounts`       | `{}`                                | Supported account names, masked suffixes, type and opaque accountIds.                |
| `fidelity_get_account_balance` | `{}` or `{ "accountId": "acct_…" }` | All supported accounts or one account, with an exact total and separate cash fields. |
| `fidelity_get_positions`       | `{}` or `{ "accountId": "acct_…" }` | Holdings grouped by all supported accounts or one account.                           |

Use the complete `accountId` returned by the accounts tool; the ellipsis above is illustrative. Account references persist within a Chrome session, including extension worker restarts and tab reloads. Restarting Chrome changes them; list accounts again. Unknown references return `ACCOUNT_NOT_FOUND`, and empty strings or raw account numbers are invalid inputs. Last-four suffixes can collide and are not lookup keys.

## Balance results

Results include `source: fidelity_internal_api`, `scope: all_visible_brokerage_accounts` or `specific_brokerage_account`, `currency`, `retrievedAt`, `totalAccountValue`, and `accounts`. Each account has an opaque accountId, a name, the last four account-number characters, and its account value. Optional fields are:

- `cashAvailableToTrade`: explicit trade cash, excluding margin buying power.
- `settledCash`: included when Fidelity provides it.
- `cashAvailableToWithdraw`: cash-only withdrawal availability, excluding margin borrowing.

Totals use integer cents. Missing values or incomplete responses return errors instead of partial totals or invented zeroes. Retrieval time is not a market-data timestamp; Fidelity data may lag. The extension calls Fidelity's internal balances API, whose routes and response shapes can change.

## Positions results

Positions include symbol, description, current value, and cash/margin classification. Quantity, last price, cost basis, daily gain/loss and unrealized gain/loss are included when supplied. Decimal strings preserve share and price precision; account headers, pending activity and totals are not holdings. Core cash is retained as a separate holding. Reads fetch Fidelity's internal positions API without navigating, using bootstrap configuration as text when necessary. Complete, valid account coverage is required; unexpected shapes return an error.

Retrieval time is not quote time. These reads are not an atomic snapshot across tools, and market prices/cost basis can lag.

## Development

```sh
npm run check
npm test
```

Tests use synthetic Fidelity data and write repeatable evidence to the ignored `artifacts/` directory. CI runs these checks on Linux and macOS and uploads the E2E evidence. See [development](docs/development.md) for test boundaries, live checks, and packaging, and [architecture](docs/architecture.md) for the source layout.

The package is private and is distributed from source; it is not published to npm or the Chrome Web Store.
