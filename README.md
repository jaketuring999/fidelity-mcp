# Fidelity MCP

Read Fidelity accounts, balances, positions, open tax lots, performance, and balance history from a local MCP client using your existing Chrome session. Fidelity MCP runs on your computer and supports a companion Chrome extension or Chrome remote debugging. This is an unofficial integration with six read-only tools.

![Codex compares cash and specific tax lots for a $10,000 withdrawal](docs/assets/codex-withdrawal.gif)

Real Codex interaction with six MCP calls, followed by Chrome connection setup. Portfolio figures are substituted for privacy; no trades or withdrawals are executed.

List accounts first, then use the returned opaque `accountId` to read one account's balance or positions. Omit `accountId` to read all visible supported Fidelity brokerage accounts, including brokerage IRAs, regardless of the account highlighted in Chrome. Hidden accounts, external accounts, and other account types are excluded. Account numbers are masked. Orders and transfers are outside the app's scope.

For tool development, start with the [offline Fidelity API reference](docs/fidelity/README.md): an endpoint catalog, synthetic examples, and reconstructed OpenAPI contracts for validated reads. Downloaded bundles and client GraphQL documents are local research evidence excluded from publication.

## Requirements

- Node.js 24.0 or newer and npm.
- Google Chrome 120 or newer on macOS or Linux.
- A local MCP client with Streamable HTTP, OAuth discovery, and a supported callback: loopback HTTP/HTTPS or Cursor's exact `https://www.cursor.com/agents/mcp/oauth/callback` URL.

The server binds to `127.0.0.1`. A cloud client cannot reach this address. Native-host setup supports macOS and Linux.

## Setup with the extension

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

## Chrome remote debugging setup

Use this extension-free path for current prototype development. It reuses your everyday Chrome session and requires Chrome 144 or newer.

1. Start Chrome normally and open `chrome://inspect/#remote-debugging`.
2. Under **Remote debugging**, check **Allow remote debugging for this browser instance**. The page should show **Server running at: 127.0.0.1:…**; the port is chosen by Chrome and does not need to be configured here.
3. From the repository root, install dependencies with `npm ci`, then run:

   ```sh
   MCP_PORT=3444 npm run start:debugging
   ```

4. Click **Allow** in Chrome's **Allow remote debugging?** connection prompt. Chrome may request approval again for a new connection.
5. Configure your MCP client with `http://127.0.0.1:3444/mcp`, then connect. Sign in and complete 2FA directly in Fidelity if prompted. The bridge reuses a portfolio tab or opens one during authorization.

Starting the server attaches to Chrome but does not open Fidelity. The MCP client must begin authorization before the bridge opens or focuses the Fidelity tab. If the client already has valid MCP credentials, it may skip authorization; open and sign in to Fidelity in the connected Chrome window if a portfolio read requires it.

Keep one server process running between tool calls and live checks. `FIDELITY_BRIDGE=chrome-debugging MCP_PORT=3444 npm run check:live` uses that server's existing connection and opens no additional debugging connection. Repeated or concurrent startup on the same bridge also reuses its connection. A new server process can still require a new Chrome approval; the app does not bypass Chrome's permission prompt.

If Cursor stays at **Connecting…** or authentication times out after changing the server URL or port, open **Customize → MCPs → fidelity**, disable the source, then enable it again. Once it shows **Needs Authentication**, click **Authenticate** and complete Fidelity sign-in in Chrome. In a live recovery, Cursor kept trying the previous port and its Reload/Authenticate actions did not start a new connection until the source was toggled.

Chrome's setting grants browser-wide control, including access to saved data, cookies and site data, and navigation. Enable it only for trusted local apps. The Fidelity MCP interface still exposes only its six read-only portfolio tools. No extension, native-host registration, or separate browser profile is required. Stopping this server disconnects it and leaves Chrome and its tabs open. Disable the setting when you no longer want apps to request debugging access. See [Chrome's setup documentation](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session) for the setting and approval flow.

If Chrome shows **Server running at: starting…** and attachment cannot find its endpoint, check whether Chrome was launched with `--remote-debugging-port` or `--remote-debugging-pipe`. Those legacy flags take precedence over the approval mode and are restricted for the ordinary Chrome profile. Save unfinished work, fully quit Chrome, then reopen it normally from your app launcher. A page reload does not remove process launch flags. Re-enable remote debugging if needed, then restart the bridge and approve Chrome's connection prompt.

## Connect the local Codex desktop app

With the server running, open **Settings → Plugins → MCPs → Add → Add MCP server** in the desktop app. Set the name to `fidelity`, choose **Streamable HTTP**, and enter `http://127.0.0.1:3444/mcp` (use your actual `MCP_PORT`). Leave bearer-token and header fields empty, save, then select **Authenticate** with automatic OAuth client registration. Complete Fidelity sign-in in Chrome if prompted.

This local MCP setup was verified with Chrome debugging, OAuth login, and tool discovery. It is saved in `~/.codex/config.toml`. A cloud connector cannot reach the server's loopback URL.

## Switch between extension and Chrome debugging

Choose the bridge at startup. Stop the current server before switching; both modes provide the same MCP tools and can use the same server URL.

| Bridge           | Start command             | Browser setup                                                   |
| ---------------- | ------------------------- | --------------------------------------------------------------- |
| Chrome debugging | `npm run start:debugging` | Enable remote debugging and approve Chrome's connection prompt. |
| Extension        | `npm run start:extension` | Run `npm run setup` and load the unpacked extension once.       |

For an existing build, use `node dist/index.js serve --bridge chrome-debugging` or `node dist/index.js serve --bridge extension`. The CLI option overrides `FIDELITY_BRIDGE`; the existing `browser-attach` environment value remains supported. Plain `npm start` retains the extension default. For source development on the debugging path, use `MCP_PORT=3444 npm run dev:debugging` after an initial `npm run build` to generate the browser adapter.

## Commands and configuration

### Dedicated-profile alternative

Run `FIDELITY_BRIDGE=browser npm start` to use a dedicated Chrome profile instead
of the extension and native host. No extension setup is required in this mode.
Connect your MCP client normally, then sign in and complete 2FA in the Chrome
window it opens. The profile is saved under `~/.fidelity-mcp/browser-profile/`;
Fidelity cookies stay in that browser profile. Account references change when
the browser-mode server restarts. Stop the server to close its dedicated Chrome.

This is an experimental transport using the same portfolio adapter and six
read-only tools. Synthetic E2E coverage does not establish live Fidelity login
compatibility. It still requires Chrome and a signed-in portfolio page. Choose
a different `MCP_PORT` if an extension-mode server is already running; each
server has its own browser connection, but both share local MCP authorization
records. Default startup continues to use the extension.

| Command                            | Purpose                                         |
| ---------------------------------- | ----------------------------------------------- |
| `npm run setup`                    | Build and register the Chrome native host.      |
| `npm start`                        | Build and run the local server.                 |
| `node dist/index.js serve`         | Run an existing build.                          |
| `node dist/index.js revoke-access` | Revoke all local MCP access and refresh grants. |

After revocation, clients must reconnect. An expired Fidelity session returns `AUTHENTICATION_REQUIRED`; sign in again in Chrome to resume portfolio reads.

| Variable          | Default     | Purpose                                                                                   |
| ----------------- | ----------- | ----------------------------------------------------------------------------------------- |
| `FIDELITY_BRIDGE` | `extension` | `extension`, `chrome-debugging` (alias `browser-attach`), or dedicated-profile `browser`. |
| `MCP_PORT`        | `3443`      | Loopback HTTP port, from 1 to 65535. Update your client URL when changing it.             |

## Tools and account selection

| Tool                           | Parameters                                    | Result                                                                                     |
| ------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `fidelity_list_accounts`       | `{}`                                          | Supported account names, masked suffixes, type and opaque accountIds.                      |
| `fidelity_get_account_balance` | `{}` or `{ "accountId": "acct_…" }`           | All supported accounts or one account, with an exact total and separate cash fields.       |
| `fidelity_get_positions`       | `{}` or `{ "accountId": "acct_…" }`           | Holdings grouped by all supported accounts or one account.                                 |
| `fidelity_get_tax_lots`        | `{ "accountId": "acct_…", "symbol": "AAPL" }` | All open lots for that held security, separated by cash/margin holding.                    |
| `fidelity_get_performance`     | `{}` or `{ "accountId": "acct_…" }`           | Per-account cumulative time-weighted pretax net returns for 1M, YTD, 1Y and 3Y.            |
| `fidelity_get_balance_history` | `{ "range": "1M", "accountId": "acct_…" }`    | Dated account values; both fields optional, default range 1Y. Supports 1M, YTD, 1Y and 3Y. |

Use the complete `accountId` returned by the accounts tool; the ellipsis above is illustrative. In extension mode, account references persist within a Chrome session, including extension worker restarts and tab reloads. Restarting Chrome changes them. In either browser mode, restarting the server changes them. List accounts again after a restart. Unknown references return `ACCOUNT_NOT_FOUND`, and empty strings or raw account numbers are invalid inputs. Last-four suffixes can collide and are not lookup keys.

Tax lots require a symbol from the selected account's positions. The tool reads every page, normalizes display currencies and percentages to decimal strings, preserves wash-sale flags and distinguishes ineligible holdings from available lots. Dates use `YYYY-MM-DD`; unavailable fields remain omitted. Basis is adjusted as reported by Fidelity. `RESPONSE_TOO_LARGE` explicitly rejects results exceeding the bounded bridge size without returning a partial set or disconnecting it.

Performance preserves Fidelity's reporting dates and marks unavailable periods. Returns are percentage units: `"5"` means 5%. Returns remain separate per account; the tool does not average them. Balance history also remains separate per account and includes cash flows, so balance changes are not investment returns. These tools read data and do not trade, transfer, reassign lots or save Fidelity preferences.

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
npx playwright install --with-deps chromium
npm test
```

Tests use synthetic Fidelity data and write repeatable evidence to the ignored `artifacts/` directory. CI runs these checks on Linux and macOS and uploads the E2E evidence. See [development](docs/development.md) for test boundaries, live checks, and packaging, and [architecture](docs/architecture.md) for the source layout.

The package is private and is distributed from source; it is not published to npm or the Chrome Web Store.
