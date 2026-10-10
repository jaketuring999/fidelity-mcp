import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_NAME, localPaths } from './paths.js';

export function extensionPath(): string {
  return fileURLToPath(new URL('../extension', import.meta.url));
}
export function extensionId(key: string): string {
  return [...createHash('sha256').update(Buffer.from(key, 'base64')).digest().subarray(0, 16)]
    .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15)))
    .join('');
}
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
export async function writeRegistration(options: {
  extensionId: string;
  base: string;
  manifestDirectory: string;
  entrypoint: string;
  node: string;
}): Promise<string> {
  if (!/^[a-p]{32}$/.test(options.extensionId))
    throw new Error('Expected a 32-character Chrome extension ID.');
  const paths = localPaths(options.base);
  await mkdir(paths.base, { recursive: true, mode: 0o700 });
  await chmod(paths.base, 0o700);
  const launcher = join(paths.base, 'native-host');
  await writeFile(
    launcher,
    `#!/bin/sh\nexec ${shellQuote(options.node)} ${shellQuote(options.entrypoint)} native-host "$@"\n`,
    { mode: 0o700 },
  );
  await chmod(launcher, 0o700);
  await writeFile(paths.config, JSON.stringify({ extensionId: options.extensionId }), {
    mode: 0o600,
  });
  await chmod(paths.config, 0o600);
  await mkdir(options.manifestDirectory, { recursive: true });
  const path = join(options.manifestDirectory, `${HOST_NAME}.json`);
  await writeFile(
    path,
    JSON.stringify(
      {
        name: HOST_NAME,
        description: 'Local Fidelity MCP Chrome bridge',
        path: launcher,
        type: 'stdio',
        allowed_origins: [`chrome-extension://${options.extensionId}/`],
      },
      null,
      2,
    ),
  );
  return path;
}
export async function runSetup(id?: string): Promise<void> {
  if (process.platform === 'win32')
    throw new Error(
      'Native-host setup currently supports macOS and Linux. A Windows launcher is not implemented yet.',
    );
  const manifest = JSON.parse(await readFile(join(extensionPath(), 'manifest.json'), 'utf8')) as {
    key: string;
  };
  const chosenId = id ?? extensionId(manifest.key);
  const manifestDirectory =
    process.platform === 'darwin'
      ? join(homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts')
      : join(
          process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
          'google-chrome/NativeMessagingHosts',
        );
  const path = await writeRegistration({
    extensionId: chosenId,
    base: localPaths().base,
    manifestDirectory,
    entrypoint: fileURLToPath(new URL('../index.js', import.meta.url)),
    node: process.execPath,
  });
  console.log(
    `Chrome bridge registered: ${path}\nExtension ID: ${chosenId}\n\nOpen chrome://extensions, enable Developer mode, and Load unpacked:\n${extensionPath()}\n\nThen run the MCP server and click Connect in the extension.`,
  );
}
