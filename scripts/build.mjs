import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], {
  cwd: root,
  stdio: 'inherit',
});
await build({
  absWorkingDir: root,
  entryPoints: ['src/bridge/fidelity-api.ts'],
  outfile: 'dist/bridge/browser-adapter.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  globalName: 'FidelityReadAdapter',
  target: 'chrome120',
});
