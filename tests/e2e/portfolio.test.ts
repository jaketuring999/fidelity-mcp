import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { ExtensionBridge } from '../../src/bridge/extension-bridge.js';
import { createServer } from '../../src/server/mcp.js';
import { writeRegistration } from '../../src/runtime/setup.js';
import { encodeMessage, MessageDecoder } from '../../src/bridge/framing.js';

test(
  'three MCP tools → real native host → bundled worker → serialized adapter: automatic sign-in/recovery, account scope, masking and failures',
  { timeout: 30_000 },
  async () => {
    const base = await mkdtemp(join(tmpdir(), 'fidelity-portfolio-e2e-'));
    const extensionId = 'a'.repeat(32);
    const bridge = new ExtensionBridge(base, () => {});
    let native: ChildProcessWithoutNullStreams | undefined;
    const assets = [
      {
        acctNum: 'TEST1234',
        acctType: 'Brokerage',
        acctSubType: 'margin',
        preferenceDetail: { name: 'Synthetic taxable' },
      },
      {
        acctNum: 'NEXT1234',
        acctType: 'Brokerage',
        acctSubType: 'ira',
        preferenceDetail: { name: 'Synthetic IRA' },
      },
      {
        acctNum: 'HIDE5678',
        acctType: 'Brokerage',
        preferenceDetail: { name: 'Hidden', isHidden: true },
      },
      { acctNum: 'EXTN6789', acctType: 'External', preferenceDetail: { name: 'External' } },
    ];
    let mode:
      | 'normal'
      | 'expired'
      | 'unavailable'
      | 'no-context'
      | 'incomplete'
      | 'wrong-account'
      | 'missing-balance'
      | 'negative-balance'
      | 'invalid-number'
      | 'empty-positions'
      | 'stale-snapshot'
      | 'duplicate-snapshot'
      | 'wrong-scope-snapshot'
      | 'unknown-row' = 'normal';
    const calls: Array<{ operation: string; ids: string[] }> = [];
    const frames: unknown[] = [];
    const storage: Record<string, unknown> = { selectedTab: 999 };
    const updates: unknown[] = [];
    let connections = 0,
      polls = 0;
    let signingIn = false,
      tabClosed = false;
    let disconnect!: () => void;
    let reconnect!: (alarm: { name: string }) => void;
    let messages!: (message: unknown) => void, start!: () => void;
    const port = {
      onMessage: {
        addListener: (fn: typeof messages) => {
          messages = fn;
        },
      },
      onDisconnect: {
        addListener: (listener: typeof disconnect) => {
          disconnect = listener;
        },
      },
      postMessage: (frame: unknown) => {
        frames.push(frame);
        native!.stdin.write(encodeMessage(frame));
      },
    };
    const tab = {
      id: 7,
      windowId: 1,
      url: 'https://digital.fidelity.com/ftgw/digital/portfolio/summary',
      active: true,
    };
    const page: Record<string, unknown> = {
      window: {
        PortSumContainer: {
          PicoService: {
            getPersonContext: async () => (mode === 'no-context' ? {} : { person: { assets } }),
          },
          StateContext: { current: () => assets[0] },
        },
      },
      location: new URL(tab.url),
      crypto: webcrypto,
      TextEncoder,
      Response,
      Blob,
      CompressionStream,
      AbortSignal,
      Uint8Array,
      atob,
      btoa,
      fetch: async (url: string, init?: RequestInit) => {
        if (mode === 'expired') return new Response('', { status: 401 });
        if (mode === 'unavailable') return new Response('', { status: 503 });
        if (url.endsWith('/balwebex/'))
          return new Response('<script>window.balExpConfig={"ctoken":"synthetic-csrf"};</script>');
        if (url.includes('/poswebex/?'))
          return new Response(
            '<script>window.posweb={"ctoken":"synthetic-csrf","user":"synthetic-customer","virtualmode":"N","virtualpwe":"multiple"};</script>',
          );
        assert.equal(init?.method, 'POST');
        assert.equal(init?.credentials, 'include');
        assert.equal((init?.headers as Record<string, string>)['X-CSRF-Token'], 'synthetic-csrf');
        assert.equal(init?.redirect, 'error');
        assert.equal(init?.cache, 'no-store');
        const body = JSON.parse(String(init?.body));
        const balance = url.endsWith('/balwebex/api/balances');
        const decoded = JSON.parse(
          gunzipSync(Buffer.from(balance ? body.picoString : body.pico, 'base64')).toString(),
        );
        const ids: string[] = balance ? decoded.map((a: any) => a.account.acctNum) : body.accts;
        assert.ok(ids.length && ids.every((id) => ['TEST1234', 'NEXT1234'].includes(id)));
        if (balance)
          assert.equal(decoded[0].account.acctSubType, ids[0] === 'TEST1234' ? 'margin' : 'ira');
        if (!balance)
          assert.deepEqual(
            decoded.accounts.map((a: any) => a.accountId),
            ids,
          );
        calls.push({ operation: balance ? 'balance' : 'positions', ids });
        let payload: any;
        if (balance)
          payload = ids
            .map((id) => ({
              account: { acctNum: id },
              balance: {
                totalAcctVal:
                  mode === 'negative-balance' ? '-0.01' : id === 'TEST1234' ? '0.10' : '0.20',
                brokBalDetail: {
                  cashDetail: { canShowCashSettled: true, cashSettled: 0 },
                  availToWithdrawDetail: {
                    cashOnlyAvailToWithdraw: '-5.20',
                    cashAvailToWithdraw: '9000.00',
                  },
                },
              },
            }))
            .reverse();
        else
          payload = {
            totalNoOfAccts: ids.length,
            acctTot: ids.map((id) => ({ acctNum: id })),
            rowData: ids
              .flatMap((id) => [
                { rowType: 'ACCOUNT', actNum: id },
                ...(mode === 'empty-positions'
                  ? []
                  : [
                      {
                        rowType: 'POSITION',
                        actNum: id,
                        sym: { name: 'TEST', desc: 'Synthetic holding' },
                        qty: { val: '1.12345678' },
                        lstPrStk: { top: { val: '12.3456' } },
                        curVal: { val: '13.87' },
                        cstBasStk: { top: { val: null } },
                        todGLStk: { top: { val: '-0.10' } },
                        meta: { holdingType: 'Margin' },
                      },
                    ]),
                {
                  rowType: 'POSITION_CORE',
                  actNum: id,
                  sym: { name: 'Cash' },
                  curVal: { val: '0.10' },
                },
                { rowType: 'PENDING', actNum: id },
                { rowType: 'ACCOUNT_TOTAL', actNum: id },
                { rowType: 'SPACER' },
              ])
              .concat({ rowType: 'GRAND_TOTAL' }),
          };
        if (mode === 'incomplete')
          payload = balance ? payload.slice(1) : { ...payload, totalNoOfAccts: 0 };
        if (mode === 'wrong-account') {
          if (balance) payload[0].account.acctNum = 'EVIL1234';
          else payload.rowData[0].actNum = 'EVIL1234';
        }
        if (mode === 'missing-balance' && balance) payload[0].balance.totalAcctVal = null;
        if (mode === 'invalid-number' && !balance) payload.rowData[1].qty.val = 'NaN';
        if (mode === 'unknown-row' && !balance)
          payload.rowData[1].rowType = 'NEW_UNSUPPORTED_POSITION';
        return Response.json(payload);
      },
    };
    const chrome = {
      runtime: {
        id: extensionId,
        connectNative: () => {
          connections++;
          return port;
        },
        onInstalled: {
          addListener: (fn: typeof start) => {
            start = fn;
          },
        },
        onStartup: { addListener: () => {} },
      },
      storage: {
        session: {
          get: async () => storage,
          set: async (value: Record<string, unknown>) => Object.assign(storage, value),
          remove: async (key: string) => {
            delete storage[key];
          },
        },
      },
      tabs: {
        get: async (id: number) => {
          if (id === 999 || (tabClosed && id === 7)) throw new Error('Tab closed');
          return { ...tab, id };
        },
        query: async () => [
          { ...tab, id: 8, active: false, lastAccessed: 200 },
          { ...tab, id: 9, active: false, lastAccessed: 100 },
          ...(tabClosed ? [] : [{ ...tab, lastAccessed: 1 }]),
        ],
        update: async (_id: number, value: unknown) => {
          updates.push(value);
          return { ...tab };
        },
        create: async () => {
          throw new Error('Portfolio reads must not open tabs');
        },
      },
      windows: { update: async () => {} },
      alarms: {
        create: async () => {},
        onAlarm: {
          addListener: (listener: typeof reconnect) => {
            reconnect = listener;
          },
        },
      },
      scripting: {
        executeScript: async (operation: any) => {
          assert.equal(operation.world, 'MAIN');
          assert.equal(operation.target.tabId, tabClosed ? 8 : 7);
          if (signingIn)
            tab.url = 'https://login.fidelity.com/ftgw/Fas/Fidelity/RtlCust/Login/Init';
          // Exercise Chrome's serialization boundary rather than calling the adapter
          // with its module closure. All provider data here is synthetic.
          const result = await runInNewContext(`(${operation.func.toString()})(...args)`, {
            ...page,
            args: operation.args,
          });
          // Corrupt normalized snapshots at the transport boundary, after the adapter.
          if (result.ok) {
            if (mode === 'stale-snapshot')
              result.retrievedAt = new Date(Date.now() - 120_000).toISOString();
            if (mode === 'duplicate-snapshot') result.accounts.push(result.accounts[0]);
            if (mode === 'wrong-scope-snapshot')
              result.accounts[0].accountId = 'acct_' + 'e'.repeat(32);
          }
          return [{ result }];
        },
      },
    };
    const bundle = await build({
      entryPoints: ['dist/extension/background.js'],
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
    });
    runInNewContext(bundle.outputFiles[0]!.text, {
      chrome,
      crypto: webcrypto,
      URL,
      Date,
      setTimeout: (callback: () => void) => {
        assert.equal(signingIn, true);
        if (++polls === 2) {
          mode = 'normal';
          signingIn = false;
          tab.url = 'https://digital.fidelity.com/ftgw/digital/portfolio/summary';
        }
        return setImmediate(callback);
      },
    });
    assert.equal(connections, 1, 'Worker connects automatically before any install event.');
    start();
    assert.equal(connections, 1, 'Install reuses the existing native connection.');
    const decoder = new MessageDecoder((message) => messages(message));
    const mcp = createServer(bridge);
    async function tool(name: string, args: Record<string, unknown> = {}) {
      const method = name === 'tools/list' ? name : 'tools/call';
      const response = await mcp.fetch(
        new Request('http://127.0.0.1/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'MCP-Protocol-Version': '2026-07-28',
            'Mcp-Method': method,
            ...(method === 'tools/call' ? { 'Mcp-Name': name } : {}),
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method,
            params: {
              ...(method === 'tools/call' ? { name, arguments: args } : {}),
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientCapabilities': {},
                'io.modelcontextprotocol/clientInfo': { name: 'portfolio-e2e', version: '1' },
              },
            },
          }),
        }),
        {
          authInfo: {
            token: 'synthetic',
            clientId: 'synthetic',
            scopes: ['fidelity:portfolio:read'],
          },
        },
      );
      const text = await response.text();
      const decoded = response.headers.get('content-type')?.includes('text/event-stream')
        ? text
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => JSON.parse(l.slice(5)))
            .find((x) => 'result' in x || 'error' in x)
        : JSON.parse(text);
      return decoded.result ?? decoded;
    }
    try {
      await writeRegistration({
        extensionId,
        base,
        manifestDirectory: join(base, 'manifests'),
        entrypoint: '/synthetic',
        node: process.execPath,
      });
      await bridge.start();
      native = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import {runNativeHost} from './dist/bridge/native-host.js';await runNativeHost(${JSON.stringify(`chrome-extension://${extensionId}/`)},${JSON.stringify(base)});`,
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      native.stdout.on('data', (chunk) => decoder.push(chunk));
      for (let n = 0; n < 150 && !bridge.connected; n++)
        await new Promise((r) => setTimeout(r, 20));
      assert.equal(bridge.connected, true);
      mode = 'expired';
      signingIn = true;
      await bridge.connectFidelity(new AbortController().signal);
      assert.equal(polls, 2, 'Readiness waits through same-tab login and completed sign-in.');
      assert.equal(storage.selectedTab, 7, 'Stale selection is discarded and the active tab wins.');
      assert.deepEqual(JSON.parse(JSON.stringify(updates)), [{ active: true }]);
      assert.deepEqual(
        JSON.parse(JSON.stringify(frames[0])),
        {
          type: 'response',
          id: (frames[0] as { id: string }).id,
          ok: true,
          result: { connected: true },
        },
        'Readiness sends no financial data or credentials.',
      );
      const firstRead = calls.length;
      const listed = await tool('tools/list');
      assert.ok(listed.tools, JSON.stringify(listed));
      assert.deepEqual(
        listed.tools.map((t: any) => t.name),
        ['fidelity_list_accounts', 'fidelity_get_account_balance', 'fidelity_get_positions'],
      );
      const accounts = (await tool('fidelity_list_accounts')).structuredContent.accounts;
      assert.equal(accounts.length, 2);
      assert.equal(accounts[0].last4, accounts[1].last4);
      assert.notEqual(accounts[0].accountId, accounts[1].accountId);
      const accountId = accounts[0].accountId;
      const all = (await tool('fidelity_get_account_balance')).structuredContent;
      assert.equal(all.totalAccountValue, '0.30');
      assert.equal(all.accounts.length, 2);
      assert.equal(all.scope, 'all_visible_brokerage_accounts');
      const one = (await tool('fidelity_get_account_balance', { accountId })).structuredContent;
      assert.equal(one.totalAccountValue, '0.10');
      assert.equal(one.accounts.length, 1);
      assert.equal(one.accounts[0].accountId, accountId);
      assert.equal(one.accounts[0].settledCash, '0.00');
      assert.equal(one.accounts[0].cashAvailableToWithdraw, '-5.20');
      assert.equal(one.accounts[0].cashAvailableToTrade, undefined);
      mode = 'negative-balance';
      assert.equal(
        (await tool('fidelity_get_account_balance', { accountId })).structuredContent
          .totalAccountValue,
        '-0.01',
      );
      mode = 'normal';
      const holdings = (await tool('fidelity_get_positions')).structuredContent;
      assert.equal(holdings.accounts.length, 2);
      assert.equal(holdings.accounts[0].positions.length, 2);
      assert.equal(holdings.accounts[0].positions[0].quantity, '1.12345678');
      assert.equal(holdings.accounts[0].positions[0].lastPrice, '12.3456');
      assert.equal(holdings.accounts[0].positions[0].holdingType, 'margin');
      assert.equal(holdings.accounts[0].positions[1].holdingType, 'cash');
      assert.equal(
        (await tool('fidelity_get_positions', { accountId })).structuredContent.accounts.length,
        1,
      );
      assert.deepEqual(
        calls.slice(firstRead, firstRead + 5).map((c) => c.ids.length),
        [2, 1, 1, 2, 1],
      );
      const before = calls.length;
      for (const name of ['fidelity_get_account_balance', 'fidelity_get_positions'])
        assert.match(
          JSON.stringify(await tool(name, { accountId: 'acct_' + 'f'.repeat(32) })),
          /ACCOUNT_NOT_FOUND/,
        );
      assert.equal(calls.length, before);
      assert.ok((await tool('fidelity_get_positions', { accountId: 'TEST1234' })).error);
      assert.ok((await tool('fidelity_get_positions', { url: 'https://evil.test' })).error);
      for (const failure of [
        'expired',
        'incomplete',
        'wrong-account',
        'invalid-number',
        'unknown-row',
      ] as const) {
        mode = failure;
        const error = await tool('fidelity_get_positions');
        assert.equal(error.isError, true);
        assert.equal(error.structuredContent, undefined);
      }
      for (const [failure, code] of [
        ['expired', 'AUTHENTICATION_REQUIRED'],
        ['unavailable', 'BALANCE_UNAVAILABLE'],
        ['no-context', 'API_CONTEXT_UNAVAILABLE'],
        ['incomplete', 'API_RESPONSE_CHANGED'],
        ['wrong-account', 'API_RESPONSE_CHANGED'],
        ['missing-balance', 'API_RESPONSE_CHANGED'],
      ] as const) {
        mode = failure;
        const error = await tool('fidelity_get_account_balance');
        assert.equal(error.isError, true);
        assert.equal(error.structuredContent, undefined);
        assert.match(JSON.stringify(error), new RegExp(code));
      }
      mode = 'empty-positions';
      const empty = (await tool('fidelity_get_positions', { accountId })).structuredContent;
      assert.equal(empty.accounts[0].positions.length, 1);
      mode = 'normal';
      for (const failure of ['stale-snapshot', 'duplicate-snapshot'] as const) {
        mode = failure;
        for (const name of [
          'fidelity_list_accounts',
          'fidelity_get_account_balance',
          'fidelity_get_positions',
        ]) {
          const rejected = await tool(name);
          assert.equal(rejected.isError, true);
          assert.equal(rejected.structuredContent, undefined);
          assert.match(JSON.stringify(rejected), /INVALID_BRIDGE_RESPONSE/);
        }
      }
      mode = 'wrong-scope-snapshot';
      for (const name of ['fidelity_get_account_balance', 'fidelity_get_positions']) {
        const rejected = await tool(name, { accountId });
        assert.equal(rejected.isError, true);
        assert.equal(rejected.structuredContent, undefined);
        assert.match(JSON.stringify(rejected), /INVALID_BRIDGE_RESPONSE/);
      }
      mode = 'normal';
      assert.equal(
        (await tool('fidelity_list_accounts')).structuredContent.accounts[0].accountId,
        accountId,
      );
      disconnect();
      reconnect({ name: 'reconnect' });
      assert.equal(connections, 2, 'Reconnect alarm restores the native port automatically.');
      tabClosed = true;
      assert.equal(
        (await tool('fidelity_list_accounts')).structuredContent.accounts[0].accountId,
        accountId,
        'Closed remembered tab falls back to most recent Fidelity tab with stable references.',
      );
      assert.equal(updates.length, 1, 'Portfolio reads and recovery never navigate or focus tabs.');
      assert.doesNotMatch(
        JSON.stringify(frames),
        /TEST1234|NEXT1234|HIDE5678|EXTN6789|synthetic-csrf|synthetic-customer|picoString/,
      );
      await mkdir('artifacts', { recursive: true });
      await writeFile(
        'artifacts/portfolio-e2e.json',
        JSON.stringify(
          {
            passed: true,
            generatedAt: new Date().toISOString(),
            repeat: 'npm test',
            runtime:
              'MCP handler, real native-host subprocess, compiled worker and serialized MAIN-world adapter; simulated Chrome and synthetic Fidelity',
            checks: [
              'Automatic startup and native-port reconnection without manual controls.',
              'Stale tab discarded; active Fidelity tab wins over more recent inactive tabs.',
              'Same-tab login/2FA wait completes through the real native-host bridge.',
              'Readiness returns only connected:true; no approval tab or financial data.',
              'Closed selected tab falls back to the most recent Fidelity tab without navigation or reference changes.',
              'Exactly three read-only tools.',
              'All supported accounts independent of current UI account selection.',
              'One account filters provider requests and results.',
              'Opaque references disambiguate matching last-four digits.',
              'References survive worker reads within a browser session.',
              'Balances add exactly in cents; negative values, zero settled cash and cash-only withdrawal semantics are preserved.',
              'Position precision preserved; headers/totals/pending rows excluded.',
              'Cash and margin distinguished.',
              'Unknown accounts do not call the provider.',
              'Invalid inputs, missing values/context, provider failures, partial responses, changed rows and expired sessions fail explicitly.',
              'Shared portfolio validation rejects stale snapshots, duplicate account references and mismatched single-account scope.',
              'Bootstrap CSRF headers and gzip requests are exercised; credentials, encoded context and full account numbers stay out of native frames.',
              'Reads never navigate or open tabs.',
            ],
          },
          null,
          2,
        ) + '\n',
      );
    } finally {
      native?.stdin.end();
      native?.kill();
      await bridge.close();
      await rm(base, { recursive: true, force: true });
    }
  },
);
