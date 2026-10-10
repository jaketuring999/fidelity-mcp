#!/usr/bin/env node
import { createServer } from './server/mcp.js';
import { ExtensionBridge } from './bridge/extension-bridge.js';
import { runNativeHost } from './bridge/native-host.js';
import { runSetup } from './runtime/setup.js';
import { openChrome } from './runtime/open-chrome.js';
import { startHttpServer } from './server/http.js';
import { revokeLocalAccess } from './server/auth.js';
import { localPaths } from './runtime/paths.js';

if (process.platform !== 'darwin' && process.platform !== 'linux') {
  console.error('Fidelity MCP supports macOS and Linux.');
  process.exit(1);
}

const command = process.argv[2];
if (command === 'native-host') {
  await runNativeHost(process.argv[3]).catch(() => {
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
  console.error('Usage: fidelity-mcp [serve | setup | revoke-access]');
  process.exitCode = 1;
} else {
  const bridge = new ExtensionBridge();
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
    const rawPort = process.env.MCP_PORT ?? '3443';
    if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535)
      throw new Error('MCP_PORT must be an integer between 1 and 65535.');
    await bridge.start();
    http = await startHttpServer(server, {
      base: localPaths().base,
      port: Number(rawPort),
      connectFidelity: async (signal) => {
        await openChrome();
        return bridge.connectFidelity(signal);
      },
    });
    console.log(
      `Fidelity MCP listening: ${http.url}\nTransport: stateless Streamable HTTP\nAdd this URL to your local OAuth-capable MCP client. Chrome opens Fidelity automatically.`,
    );
  } catch (error) {
    console.error(
      `[fidelity-mcp] ${error instanceof Error ? error.message : 'Could not start HTTP server.'}`,
    );
    await stop();
    process.exitCode = 1;
  }
}
