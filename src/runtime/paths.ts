import { homedir } from 'node:os';
import { join } from 'node:path';

export function localPaths(base = join(homedir(), '.fidelity-mcp')) {
  return { base };
}
