import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const run = promisify(execFile);
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

test('packed app includes the browser adapter and runs its CLI', { timeout: 30_000 }, async () => {
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
    const { files: configuredFiles } = JSON.parse(await readFile('package.json', 'utf8')) as {
      files: string[];
    };
    const explicitFiles = configuredFiles.filter((file) => !file.includes('*'));
    const publicDocs = explicitFiles.filter((file) => file.startsWith('docs/'));
    for (const required of ['dist/index.js', 'dist/bridge/browser-adapter.js', ...explicitFiles]) {
      assert.ok(files.includes(required), `Missing packaged file: ${required}`);
    }
    assert.ok(
      files.every(
        (file) =>
          ['package.json', 'README.md', ...explicitFiles].includes(file) ||
          /^dist\/(?:[a-z-]+\/)*[a-z-]+\.js$/.test(file),
      ),
      'Only allowlisted runtime code and curated documentation belong in the package.',
    );
    assert.ok(
      files.every((file) => !forbiddenFile.test(file)),
      'Package must exclude research, runtime data and credentials.',
    );
    const archive = join(temporary, metadata.filename);
    await run('tar', ['-xzf', archive, '-C', temporary]);
    const packaged = join(temporary, 'package');
    for (const file of files) assertPublicText(file, await readFile(join(packaged, file), 'utf8'));
    // Inspect what Git would publish, including force-added ignored files.
    // This works before the first commit as well as in an existing checkout.
    const deleted = new Set((await run('git', ['ls-files', '--deleted', '-z'])).stdout.split('\0'));
    const candidates = [
      ...new Set(
        (await run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).stdout
          .split('\0')
          .filter((file) => file && !deleted.has(file)),
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
          'docs/assets/codex-withdrawal.gif',
          'package.json',
          'package-lock.json',
          'tsconfig.json',
          ...publicDocs,
        ].includes(file) ||
          /^(?:src|tests\/e2e|\.github\/workflows)\//.test(file) ||
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
    const help = await cli('--help');
    assert.match(help.stdout, /--bridge chrome-debugging/);
    for (const bridge of ['chrome-debugging', 'browser']) {
      // Verify selection and precedence without starting a real browser or listener.
      await assert.rejects(
        run(process.execPath, [entrypoint, 'serve', '--bridge', bridge], {
          cwd: packaged,
          env: { ...env, FIDELITY_BRIDGE: 'invalid', MCP_PORT: 'invalid' },
        }),
        (error: Error & { stderr?: string }) =>
          /MCP_PORT must be an integer/.test(error.stderr ?? ''),
      );
    }
    await assert.rejects(
      run(process.execPath, [entrypoint, 'serve', '--bridge', 'invalid'], {
        cwd: packaged,
        env,
      }),
      (error: Error & { stderr?: string }) =>
        /Invalid bridge selection from CLI/.test(error.stderr ?? ''),
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
            'Package includes the bundled browser adapter.',
            'Extracted CLI documents bridge choices, rejects invalid selection, and gives CLI selection precedence over the environment.',
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
});
