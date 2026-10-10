import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], {
  cwd: root,
  stdio: 'inherit',
});
await mkdir(new URL('../dist/extension/', import.meta.url), { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ['extension/src/background.ts', 'extension/src/popup.ts'],
  outdir: 'dist/extension',
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'chrome120',
});
for (const name of ['manifest.json', 'popup.html', 'popup.css']) {
  await copyFile(
    new URL(`../extension/assets/${name}`, import.meta.url),
    new URL(`../dist/extension/${name}`, import.meta.url),
  );
}
