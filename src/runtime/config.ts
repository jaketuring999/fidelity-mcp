import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { localPaths } from './paths.js';

export async function loadConfig(base = localPaths().base, env: NodeJS.ProcessEnv = process.env) {
  await mkdir(base, { recursive: true, mode: 0o700 });
  await chmod(base, 0o700);
  const rawPort = env.MCP_PORT ?? '3443';
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535)
    throw new Error('MCP_PORT must be an integer between 1 and 65535.');
  return { base, port: Number(rawPort), clientConfigPath: join(base, 'client-config.json') };
}

export async function writeClientConfig(path: string, url: string): Promise<void> {
  await writeFile(path, JSON.stringify({ mcpServers: { fidelity: { url } } }, null, 2) + '\n', {
    mode: 0o600,
  });
  await chmod(path, 0o600);
}
