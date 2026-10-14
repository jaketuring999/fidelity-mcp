import { z } from 'zod';

const bridgeModes = {
  'chrome-debugging': 'browser-attach',
  // Compatibility alias, not a fallback for an unknown mode.
  'browser-attach': 'browser-attach',
  browser: 'browser',
} as const;
const bridgeName = z.enum(['chrome-debugging', 'browser-attach', 'browser']);

// Resolve once before creating transports or opening Chrome. Empty/invalid values
// are errors; only an absent value selects the documented default.
export function resolveServeConfig(cliBridge: string | undefined, env: NodeJS.ProcessEnv) {
  const source =
    cliBridge !== undefined ? 'CLI' : env.FIDELITY_BRIDGE !== undefined ? 'environment' : 'default';
  const parsed = bridgeName.safeParse(cliBridge ?? env.FIDELITY_BRIDGE ?? 'chrome-debugging');
  if (!parsed.success)
    throw new Error(
      `Invalid bridge selection from ${source}. Expected chrome-debugging, browser or browser-attach.`,
    );
  const rawPort = env.MCP_PORT ?? '3443';
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535)
    throw new Error('MCP_PORT must be an integer between 1 and 65535.');
  return { bridge: bridgeModes[parsed.data], source, port: Number(rawPort) } as const;
}
