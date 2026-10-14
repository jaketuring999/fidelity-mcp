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
    for (const selection of [[], ['--bridge', 'chrome-debugging']]) {
      const result = await run(
        process.execPath,
        [resolve('dist/index.js'), 'serve', ...selection],
        {
          env: {
            ...process.env,
            HOME: home,
            XDG_CONFIG_HOME: join(home, '.config'),
            FIDELITY_BRIDGE: undefined,
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
      assert.equal(
        result.stderr.includes(home),
        false,
        'Provider diagnostics must remain private.',
      );
    }
    await mkdir('artifacts', { recursive: true });
    await writeFile(
      'artifacts/browser-startup-e2e.json',
      JSON.stringify(
        {
          passed: true,
          generatedAt: new Date().toISOString(),
          repeat: 'npm run build && npx tsx --test tests/e2e/browser-startup.test.ts',
          scenario:
            'Compiled CLI with default and explicit Chrome debugging selection; no endpoint in an isolated home.',
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

test('compiled CLI validates configuration before creating a browser or runtime state', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fidelity-config-startup-'));
  const cases = [
    {
      name: 'unknown CLI bridge',
      args: ['--bridge', 'typo'],
      bridge: 'chrome-debugging',
      port: '3443',
      expected: 'Invalid bridge selection from CLI',
    },
    {
      name: 'empty CLI bridge',
      args: ['--bridge', ''],
      bridge: 'chrome-debugging',
      port: '3443',
      expected: 'Invalid bridge selection from CLI',
    },
    {
      name: 'unknown environment bridge',
      args: [],
      bridge: 'typo',
      port: '3443',
      expected: 'Invalid bridge selection from environment',
    },
    {
      name: 'empty environment bridge',
      args: [],
      bridge: '',
      port: '3443',
      expected: 'Invalid bridge selection from environment',
    },
    {
      name: 'CLI overrides invalid environment',
      args: ['--bridge', 'chrome-debugging'],
      bridge: 'typo',
      port: '0',
      expected: 'MCP_PORT must be an integer',
    },
    ...['chrome-debugging', 'browser-attach', 'browser'].map((bridge) => ({
      name: `explicit ${bridge}`,
      args: [],
      bridge,
      port: '0',
      expected: 'MCP_PORT must be an integer',
    })),
    {
      name: 'absent bridge uses documented default',
      args: [],
      bridge: undefined,
      port: '0',
      expected: 'MCP_PORT must be an integer',
    },
  ];
  try {
    for (const scenario of cases) {
      const env = {
        ...process.env,
        HOME: home,
        FIDELITY_BRIDGE: scenario.bridge,
        MCP_PORT: scenario.port,
      };
      if (scenario.bridge === undefined) delete env.FIDELITY_BRIDGE;
      await run(process.execPath, [resolve('dist/index.js'), 'serve', ...scenario.args], {
        env,
        timeout: 5000,
      }).then(
        () => assert.fail(`Unexpected startup: ${scenario.name}`),
        (error: Error & { code?: number; stderr?: string; stdout?: string; killed?: boolean }) => {
          assert.equal(error.code, 1, scenario.name);
          assert.equal(error.killed, false, scenario.name);
          assert.ok(error.stderr?.includes(scenario.expected), scenario.name);
          assert.equal(error.stdout, '', scenario.name);
        },
      );
    }
    const { readdir } = await import('node:fs/promises');
    assert.deepEqual(
      await readdir(home),
      [],
      'Configuration errors must not create runtime state.',
    );
    await mkdir('artifacts', { recursive: true });
    await writeFile(
      'artifacts/config-startup-e2e.json',
      JSON.stringify(
        {
          passed: true,
          generatedAt: new Date().toISOString(),
          repeat: 'npm run build && npx tsx --test tests/e2e/browser-startup.test.ts',
          checks: cases.map(({ name }) => name),
          boundary:
            'Compiled CLI rejects bad bridge/port configuration before transport startup; accepted bridge selections are followed by an intentional invalid port.',
        },
        null,
        2,
      ) + '\n',
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
