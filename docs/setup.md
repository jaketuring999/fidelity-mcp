# Setup and troubleshooting

[Back to the overview](../README.md).

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

Local clients receive portfolio read access when the extension confirms a working Fidelity session. There is no client approval step. The client stores and refreshes its own MCP tokens; Fidelity credentials, cookies, and 2FA codes stay in Chrome. See [security and authorization](security.md) for the trust boundary.

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
