import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const run = promisify(execFile);
const publicDocs = [
  'docs/architecture.md',
  'docs/development.md',
  'docs/security.md',
  'docs/fidelity/README.md',
  'docs/fidelity/shared-context.md',
  'docs/fidelity/openapi.json',
  'docs/fidelity/examples.json',
  'docs/fidelity/endpoint-catalog.json',
];
const forbiddenFile =
  /(?:^|\/)(?:\.env(?:\..*)?|\.cursor|\.fidelity(?:-mcp)?|artifacts|raw|graphql|node_modules)(?:\/|$)|\.(?:sqlite(?:-.*)?|db(?:-.*)?|pem|key|p12|pfx|har|tgz|log)$/i;
const sensitiveText = [
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{60,}\b/,
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/,
  /(?:\/Users\/|\/home\/)[A-Za-z0-9_.-]+\//,
];
function assertPublicText(path: string, text: string) {
  for (const pattern of sensitiveText)
    assert.equal(
      pattern.test(text),
      false,
      `Potential sensitive content in ${path}; inspect locally.`,
    );
}

test(
  'packed app runs its CLI and registers the native host with the bundled extension',
  { timeout: 30_000 },
  async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), 'fidelity-package-e2e-')));
    try {
      const packed = await run('npm', [
        'pack',
        '--ignore-scripts',
        '--json',
        '--pack-destination',
        temporary,
      ]);
      const [metadata] = JSON.parse(packed.stdout) as Array<{
        filename: string;
        files: Array<{ path: string }>;
      }>;
      assert.ok(metadata);
      const files = metadata.files.map((file) => file.path).sort();
      for (const required of [
        'dist/index.js',
        'dist/runtime/setup.js',
        'dist/bridge/native-host.js',
        'dist/extension/manifest.json',
        'dist/extension/background.js',
        'dist/extension/popup.js',
        'dist/extension/popup.html',
        'dist/extension/popup.css',
        'README.md',
        'docs/development.md',
      ]) {
        assert.ok(files.includes(required), `Missing packaged file: ${required}`);
      }
      assert.ok(
        files.every(
          (file) =>
            [
              'package.json',
              'README.md',
              ...publicDocs,
              'dist/extension/manifest.json',
              'dist/extension/popup.html',
              'dist/extension/popup.css',
            ].includes(file) || /^dist\/(?:[a-z-]+\/)*[a-z-]+\.js$/.test(file),
        ),
        'Only allowlisted runtime code and curated documentation belong in the package.',
      );
      assert.ok(
        files.every((file) => !forbiddenFile.test(file)),
        'Package must exclude research, runtime data and credentials.',
      );
      for (const doc of publicDocs)
        assert.ok(files.includes(doc), `Missing public documentation: ${doc}`);
      const archive = join(temporary, metadata.filename);
      await run('tar', ['-xzf', archive, '-C', temporary]);
      const packaged = join(temporary, 'package');
      for (const file of files)
        assertPublicText(file, await readFile(join(packaged, file), 'utf8'));
      // Inspect what Git would publish, including force-added ignored files.
      // This works before the first commit as well as in an existing checkout.
      const candidates = [
        ...new Set(
          (
            await run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
          ).stdout
            .split('\0')
            .filter(Boolean),
        ),
      ].sort();
      const publicFiles = [];
      for (const file of candidates) {
        assert.equal(forbiddenFile.test(file), false, `Unsafe Git publication candidate: ${file}`);
        assert.ok(
          [
            '.gitignore',
            'eslint.config.mjs',
            '.prettierrc.json',
            '.prettierignore',
            'AGENTS.md',
            'README.md',
            'package.json',
            'package-lock.json',
            'tsconfig.json',
            ...publicDocs,
          ].includes(file) ||
            /^(?:src|extension|tests\/e2e|\.github\/workflows)\//.test(file) ||
            ['scripts/build.mjs', 'scripts/check-live.ts'].includes(file),
          `Unexpected public file: ${file}; review before widening the publication boundary.`,
        );
        const bytes = await readFile(file);
        assertPublicText(file, bytes.toString('utf8'));
        publicFiles.push({
          path: file,
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
      }
      // Reuse installed dependencies; only app code and assets come from the tarball.
      await symlink(resolve('node_modules'), join(packaged, 'node_modules'), 'dir');
      const entrypoint = join(packaged, 'dist/index.js');
      const home = join(temporary, 'home');
      const xdg = join(home, '.config');
      const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg };
      const cli = (command: string) =>
        run(process.execPath, [entrypoint, command], { cwd: packaged, env });
      const extension = (await cli('extension-path')).stdout.trim();
      assert.equal(extension, join(packaged, 'dist/extension'));
      const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
      const digest = createHash('sha256')
        .update(Buffer.from(manifest.key, 'base64'))
        .digest()
        .subarray(0, 16);
      const extensionId = [...digest]
        .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15)))
        .join('');
      for (const asset of [
        manifest.background.service_worker,
        manifest.action.default_popup,
        'popup.js',
        'popup.css',
      ]) {
        assert.ok((await stat(join(extension, asset))).isFile());
      }
      const setup = await cli('setup');
      assert.ok(setup.stdout.includes(extension));
      const registrationDirectory =
        process.platform === 'darwin'
          ? join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts')
          : join(xdg, 'google-chrome/NativeMessagingHosts');
      const registration = JSON.parse(
        await readFile(join(registrationDirectory, 'com.fidelity_mcp.bridge.json'), 'utf8'),
      );
      assert.deepEqual(registration.allowed_origins, [`chrome-extension://${extensionId}/`]);
      assert.equal(registration.path, join(home, '.fidelity-mcp/native-host'));
      const launcher = await readFile(registration.path, 'utf8');
      assert.ok(launcher.includes(entrypoint));
      assert.ok(launcher.includes(process.execPath));
      assert.equal((await stat(registration.path)).mode & 0o777, 0o700);
      const rejected = await run(
        registration.path,
        ['chrome-extension://' + 'a'.repeat(32) + '/'],
        { env },
      ).then(
        () => false,
        () => true,
      );
      assert.equal(
        rejected,
        true,
        'Native launcher must execute and reject an unregistered origin.',
      );
      await mkdir('artifacts', { recursive: true });
      await writeFile(
        'artifacts/package-e2e.json',
        JSON.stringify(
          {
            passed: true,
            generatedAt: new Date().toISOString(),
            repeat: 'npm test',
            environment: { node: process.version, platform: process.platform },
            packageSha256: createHash('sha256')
              .update(await readFile(archive))
              .digest('hex'),
            files,
            publicFiles,
            checks: [
              'Package includes allowlisted runtime and curated documentation only.',
              'Git publication candidates exclude local research, runtime data, private-key files and common credential patterns.',
              'Public file inventory records SHA-256 hashes without file contents.',
              'Extracted CLI resolves bundled extension assets.',
              'Setup registers the stable extension ID in an isolated home.',
              'Private native launcher points to the extracted CLI and executes.',
            ],
            dependencies:
              'Reused checkout node_modules; clean dependency installation is verified separately by CI npm ci.',
          },
          null,
          2,
        ) + '\n',
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);
