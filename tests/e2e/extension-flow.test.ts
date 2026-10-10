import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { webcrypto, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

test('bundled Chrome worker follows sign-in in the same tab and completes connection without approval UI', async () => {
  const bundle = await build({
    entryPoints: ['dist/extension/background.js'],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
  });
  const selected: { selectedTab?: number; accountSalt?: string } = {};
  const tab = {
    id: 7,
    windowId: 1,
    active: true,
    url: 'https://digital.fidelity.com/ftgw/digital/portfolio/summary',
  };
  const updates: unknown[] = [],
    opened: unknown[] = [],
    frames: any[] = [];
  let messages!: (message: unknown) => void, disconnect!: () => void, start!: () => void;
  let login = false,
    reads = 0,
    sleeps = 0;
  const balances = {
    ok: true,
    endpoint: 'https://digital.fidelity.com/ftgw/digital/balwebex/api/balances',
    retrievedAt: new Date().toISOString(),
    accounts: [{ last4: '1234', name: 'Synthetic account', totalAccountValue: '42.00' }],
  };
  const port = {
    onMessage: {
      addListener: (listener: typeof messages) => {
        messages = listener;
      },
    },
    onDisconnect: {
      addListener: (listener: typeof disconnect) => {
        disconnect = listener;
      },
    },
    postMessage: (value: unknown) => {
      frames.push(value);
    },
  };
  const chrome = {
    runtime: {
      id: 'a'.repeat(32),
      connectNative: () => port,
      onMessage: { addListener: () => {} },
      onInstalled: {
        addListener: (listener: typeof start) => {
          start = listener;
        },
      },
      onStartup: { addListener: () => {} },
    },
    storage: {
      session: {
        get: async () => selected,
        set: async (value: { selectedTab: number }) => {
          Object.assign(selected, value);
        },
        remove: async () => {
          delete selected.selectedTab;
        },
      },
    },
    tabs: {
      get: async () => ({ ...tab }),
      query: async () => [{ ...tab }],
      create: async (value: unknown) => {
        opened.push(value);
        return { ...tab };
      },
      update: async (_id: number, value: unknown) => {
        updates.push(value);
        return { ...tab };
      },
    },
    windows: { update: async () => {} },
    scripting: {
      executeScript: async (operation: any) => {
        assert.equal(operation.world, 'MAIN');
        assert.equal(operation.target.tabId, 7);
        assert.equal(operation.func.name, 'fetchFidelityPortfolio');
        assert.equal(operation.args[0], 'read_balance');
        assert.match(operation.args[2], /^[a-f0-9]{64}$/);
        reads++;
        if (!login) {
          tab.url = 'https://login.fidelity.com/ftgw/Fas/Fidelity/RtlCust/Login/Init';
          return [{ result: { ok: false, code: 'AUTHENTICATION_REQUIRED' } }];
        }
        return [{ result: balances }];
      },
    },
    alarms: { create: async () => {}, onAlarm: { addListener: () => {} } },
  };
  runInNewContext(bundle.outputFiles[0]!.text, {
    chrome,
    crypto: webcrypto,
    URL,
    Date,
    setTimeout: (callback: () => void) => {
      // First poll crosses to login; next poll represents completed sign-in/2FA.
      if (++sleeps === 2) {
        login = true;
        tab.url = 'https://digital.fidelity.com/ftgw/digital/portfolio/summary';
      }
      return setImmediate(callback);
    },
  });
  start();
  messages({ type: 'status', connected: true });
  const id = randomUUID();
  messages({ type: 'command', id, operation: 'connect_fidelity', expiresAt: Date.now() + 60_000 });
  for (let attempt = 0; attempt < 100 && !frames.length; attempt++) await new Promise(setImmediate);
  assert.equal(frames.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(frames[0])), {
    type: 'response',
    id,
    ok: true,
    result: { connected: true },
  });
  assert.ok(sleeps >= 2);
  assert.equal(reads, 2);
  assert.equal(selected.selectedTab, 7);
  assert.deepEqual(JSON.parse(JSON.stringify(updates)), [{ active: true }]);
  assert.deepEqual(opened, []); // Existing Fidelity tab; no local or extension approval tab.
  messages({ type: 'command', id: randomUUID(), operation: 'read_balance' });
  for (let attempt = 0; attempt < 100 && frames.length < 2; attempt++)
    await new Promise(setImmediate);
  assert.equal(frames[1]?.result.accounts[0].totalAccountValue, '42.00');
  assert.equal(updates.length, 1); // Balance calls never navigate or open tabs.
  disconnect();
  await mkdir('artifacts', { recursive: true });
  await writeFile(
    'artifacts/extension-flow-e2e.json',
    JSON.stringify(
      {
        passed: true,
        generatedAt: new Date().toISOString(),
        repeat: 'npm test',
        runtime: 'real bundled extension worker in simulated Chrome APIs',
        fidelityData: 'synthetic',
        checks: [
          'Existing Fidelity tab focused automatically.',
          'Same tab survives login redirect and sign-in/2FA wait.',
          'Readiness response contains only connected:true, without balances or credentials.',
          'No approval tab or UI decision.',
          'Subsequent balance call reuses session without navigation.',
        ],
      },
      null,
      2,
    ) + '\n',
  );
});
