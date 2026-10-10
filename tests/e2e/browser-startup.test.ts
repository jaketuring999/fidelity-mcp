import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const run = promisify(execFile);

test('compiled CLI explains how to enable unavailable Chrome remote debugging', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fidelity-debugging-startup-'));
  try {
    // No DevToolsActivePort in this isolated home: never touch everyday Chrome.
    const result = await run(
      process.execPath,
      [resolve('dist/index.js'), 'serve', '--bridge', 'chrome-debugging'],
      {
        env: {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: join(home, '.config'),
          FIDELITY_BRIDGE: 'extension',
          MCP_PORT: '3444',
        },
        timeout: 15_000,
      },
    ).then(
      () => assert.fail('Startup must fail when Chrome debugging is unavailable.'),
      (error: Error & { code?: number; stderr?: string; stdout?: string; killed?: boolean }) => {
        assert.equal(error.killed, false, 'CLI must exit rather than hang.');
        assert.equal(error.code, 1);
        return { stderr: error.stderr ?? '', stdout: error.stdout ?? '' };
      },
    );
    for (const instruction of [
      'Could not connect to Chrome remote debugging',
      'Google Chrome 144 or newer',
      'chrome://inspect/#remote-debugging',
      'Allow remote debugging for this browser instance',
      'Server running at: 127.0.0.1:',
      'Rerun your server command with --bridge chrome-debugging',
      'click "Allow"',
      'fully quit Chrome',
      '--remote-debugging-port',
    ]) {
      assert.ok(result.stderr.includes(instruction), `Missing setup instruction: ${instruction}`);
    }
    assert.equal(result.stdout.includes('Fidelity MCP listening:'), false);
    assert.equal(result.stderr.includes(home), false, 'Provider diagnostics must remain private.');
    await mkdir('artifacts', { recursive: true });
    await writeFile(
      'artifacts/browser-startup-e2e.json',
      JSON.stringify(
        {
          passed: true,
          generatedAt: new Date().toISOString(),
          repeat: 'npm run build && npx tsx --test tests/e2e/browser-startup.test.ts',
          scenario:
            'Compiled CLI with --bridge chrome-debugging and no Chrome debugging endpoint in an isolated home.',
          checks: [
            'Exits with code 1 without starting the MCP listener or hanging.',
            'Explains the Chrome setting, endpoint readiness, restart command and Allow prompt.',
            'Includes recovery for legacy launch flags without exposing internal diagnostics.',
            'Does not connect to or change the user browser.',
          ],
        },
        null,
        2,
      ) + '\n',
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
