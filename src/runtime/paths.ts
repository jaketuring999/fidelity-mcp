import { homedir } from 'node:os';
import { join } from 'node:path';

export const HOST_NAME = 'com.fidelity_mcp.bridge';
export function localPaths(base = join(homedir(), '.fidelity-mcp')) {
  return {
    base,
    socket: join(base, 'bridge.sock'),
    token: join(base, 'bridge-token'),
    config: join(base, 'config.json'),
  };
}
