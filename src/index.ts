#!/usr/bin/env node
import { createServer } from './server/mcp.js';
import { ExtensionBridge } from './bridge/extension-bridge.js';
import { BrowserBridge } from './bridge/browser-bridge.js';
import { runNativeHost } from './bridge/native-host.js';
import { runSetup } from './runtime/setup.js';
import { openChrome } from './runtime/open-chrome.js';
import { startHttpServer } from './server/http.js';
import { revokeLocalAccess } from './server/auth.js';
import { localPaths } from './runtime/paths.js';
import { resolveServeConfig } from './runtime/config.js';
import { parseArgs } from 'node:util';

const usage = `Usage: fidelity-mcp [serve | setup | revoke-access] [--bridge extension|chrome-debugging|browser]
  --bridge extension         Use the companion extension (default).
  --bridge chrome-debugging  Attach to everyday Chrome with remote debugging enabled.
  --bridge browser           Launch a dedicated Chrome profile.
CLI selection overrides FIDELITY_BRIDGE. Restart the server to switch bridges.`;
let args: { values: { bridge?: string; help?: boolean }; positionals: string[] };
try {
  args = parseArgs({
    options: { bridge: { type: 'string' }, help: { type: 'boolean' } },
    allowPositionals: true,
  });
} catch {
  console.error(usage);
  process.exit(1);
}
if (args.values.help) {
  console.log(usage);
  process.exit(0);
}

if (process.platform !== 'darwin' && process.platform !== 'linux') {
  console.error('Fidelity MCP supports macOS and Linux.');
  process.exit(1);
}

const command = args.positionals[0];
if (command === 'native-host') {
  await runNativeHost(args.positionals[1]).catch(() => {
    console.error('[fidelity-mcp] Native bridge startup failed. Run fidelity-mcp setup again.');
    process.exit(1);
  });
} else if (command === 'setup') {
  await runSetup();
} else if (command === 'revoke-access') {
  await revokeLocalAccess(localPaths().base);
  console.log(
    'All agent grants revoked. Agents must connect and sign in to Fidelity again if needed.',
  );
} else if (command && command !== 'serve') {
  console.error(usage);
  process.exitCode = 1;
} else {
  let config: ReturnType<typeof resolveServeConfig>;
  try {
    config = resolveServeConfig(args.values.bridge, process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Invalid server configuration.');
    process.exit(1);
  }
  const mode = config.bridge;
  const bridge =
    mode === 'extension'
      ? new ExtensionBridge()
      : new BrowserBridge(undefined, { attach: mode === 'browser-attach' });
  const server = createServer(bridge);
  let http: Awaited<ReturnType<typeof startHttpServer>> | undefined;
  let shutdown: Promise<void> | undefined;
  function stop(): Promise<void> {
    shutdown ??= (async () => {
      await bridge.close();
      if (http) await http.close();
      else await server.close();
    })();
    return shutdown;
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      void stop().finally(() => process.exit(0));
    });
  try {
    await bridge.start();
    http = await startHttpServer(server, {
      base: localPaths().base,
      port: config.port,
      connectFidelity: async (signal) => {
        if (mode === 'extension') await openChrome();
        return bridge.connectFidelity(signal);
      },
    });
    console.log(
      `Fidelity MCP listening: ${http.url}\nBridge: ${mode === 'browser-attach' ? 'chrome-debugging' : mode} (${config.source})\nTransport: stateless Streamable HTTP\nAdd this URL to your local OAuth-capable MCP client and connect. During client authorization, Chrome opens or focuses Fidelity for sign-in and 2FA if needed. Starting the server alone does not open Fidelity.`,
    );
  } catch (error) {
    console.error(
      `[fidelity-mcp] ${error instanceof Error ? error.message : 'Could not start HTTP server.'}`,
    );
    await stop();
    process.exitCode = 1;
  }
}
