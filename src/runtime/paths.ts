import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const HOST_NAME = 'com.fidelity_mcp.bridge';
export function localPaths(base = join(homedir(), '.fidelity-mcp')) {
  return {
    base,
    socket:
      process.platform === 'win32'
        ? `\\\\.\\pipe\\fidelity-mcp-${createHash('sha256').update(base).digest('hex').slice(0, 16)}`
        : join(base, 'bridge.sock'),
    token: join(base, 'bridge-token'),
    config: join(base, 'config.json'),
  };
}
