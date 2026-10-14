# Setup and troubleshooting

[Back to the overview](../README.md).

## Requirements

- Node.js 24.0 or newer and npm.
- Google Chrome 144 or newer on macOS or Linux.
- A local MCP client with Streamable HTTP, OAuth discovery, and a supported callback: loopback HTTP/HTTPS or Cursor's exact `https://www.cursor.com/agents/mcp/oauth/callback` URL.

The server binds to `127.0.0.1`. A cloud client cannot reach this address.

## Chrome remote debugging setup

The server connects to your everyday Chrome session by default.

1. Start Chrome normally and open `chrome://inspect/#remote-debugging`.
2. Under **Remote debugging**, check **Allow remote debugging for this browser instance**. The page should show **Server running at: 127.0.0.1:…**; the port is chosen by Chrome and does not need to be configured here.
3. From the repository root, install dependencies with `npm ci`, then run:

   ```sh
   MCP_PORT=3444 npm start
   ```

4. Click **Allow** in Chrome's **Allow remote debugging?** connection prompt. Chrome may request approval again for a new connection.
5. Configure your MCP client with `http://127.0.0.1:3444/mcp`, then connect. Sign in and complete 2FA directly in Fidelity if prompted. The bridge reuses a portfolio tab or opens one during authorization.

Starting the server attaches to Chrome but does not open Fidelity. The MCP client must begin authorization before the bridge opens or focuses the Fidelity tab. If the client already has valid MCP credentials, it may skip authorization; open and sign in to Fidelity in the connected Chrome window if a portfolio read requires it.

Keep one server process running between tool calls and live checks. `MCP_PORT=3444 npm run check:live` uses that server's existing connection and opens no additional debugging connection. Repeated or concurrent startup on the same bridge also reuses its connection. A new server process can still require a new Chrome approval; the app does not bypass Chrome's permission prompt.

If Cursor stays at **Connecting…** or authentication times out after changing the server URL or port, open **Customize → MCPs → fidelity**, disable the source, then enable it again. Once it shows **Needs Authentication**, click **Authenticate** and complete Fidelity sign-in in Chrome. In a live recovery, Cursor kept trying the previous port and its Reload/Authenticate actions did not start a new connection until the source was toggled.

Chrome's setting grants browser-wide control, including access to saved data, cookies and site data, and navigation. Enable it only for trusted local apps. The Fidelity MCP interface still exposes only its six read-only portfolio tools. Stopping this server disconnects it and leaves Chrome and its tabs open. Disable the setting when you no longer want apps to request debugging access. See [Chrome's setup documentation](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session) for the setting and approval flow.

If Chrome shows **Server running at: starting…** and attachment cannot find its endpoint, check whether Chrome was launched with `--remote-debugging-port` or `--remote-debugging-pipe`. Those legacy flags take precedence over the approval mode and are restricted for the ordinary Chrome profile. Save unfinished work, fully quit Chrome, then reopen it normally from your app launcher. A page reload does not remove process launch flags. Re-enable remote debugging if needed, then restart the bridge and approve Chrome's connection prompt.

## Connect the local Codex desktop app

With the server running, open **Settings → Plugins → MCPs → Add → Add MCP server** in the desktop app. Set the name to `fidelity`, choose **Streamable HTTP**, and enter `http://127.0.0.1:3444/mcp` (use your actual `MCP_PORT`). Leave bearer-token and header fields empty, save, then select **Authenticate** with automatic OAuth client registration. Complete Fidelity sign-in in Chrome if prompted.

This local MCP setup was verified with Chrome debugging, OAuth login, and tool discovery. It is saved in `~/.codex/config.toml`. A cloud connector cannot reach the server's loopback URL.

## Commands and configuration

### Dedicated-profile alternative

Run `FIDELITY_BRIDGE=browser npm start` to launch a dedicated Chrome profile.
Connect your MCP client, then sign in and complete 2FA in its Chrome window.
The profile is saved under `~/.fidelity-mcp/browser-profile/`; Fidelity cookies
stay in that profile. Stopping the server closes its dedicated Chrome.

This experimental mode uses the same adapter and six read-only tools. Synthetic
E2E coverage does not establish live Fidelity login compatibility. Each server
has its own browser connection and shares local MCP authorization records.

| Command                            | Purpose                                         |
| ---------------------------------- | ----------------------------------------------- |
| `npm start`                        | Build and run the local server.                 |
| `node dist/index.js serve`         | Run an existing build.                          |
| `node dist/index.js revoke-access` | Revoke all local MCP access and refresh grants. |

After revocation, clients must reconnect. An expired Fidelity session returns `AUTHENTICATION_REQUIRED`; sign in again in Chrome to resume portfolio reads.

| Variable          | Default            | Purpose                                                                       |
| ----------------- | ------------------ | ----------------------------------------------------------------------------- |
| `FIDELITY_BRIDGE` | `chrome-debugging` | `chrome-debugging` (alias `browser-attach`), or dedicated-profile `browser`.  |
| `MCP_PORT`        | `3443`             | Loopback HTTP port, from 1 to 65535. Update your client URL when changing it. |

The CLI `--bridge` option overrides `FIDELITY_BRIDGE`. Plain `npm start` attaches to everyday Chrome. For source development, run `npm run build` once to bundle the adapter, then `MCP_PORT=3444 npm run dev`.

Local clients receive portfolio read access after the browser confirms a working Fidelity session. Client tokens are separate from Fidelity credentials and cookies. See [security and authorization](security.md). Runtime state lives under `~/.fidelity-mcp/`.
