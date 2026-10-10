import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { BrowserBridge } from '../../dist/bridge/browser-bridge.js';
import { createServer } from '../../dist/server/mcp.js';
import { chromium, type BrowserContext } from 'playwright';

for (const attach of [false, true])
  test(
    `MCP → ${attach ? 'attach to existing' : 'owned'} real Chromium → bundled adapter → synthetic Fidelity HTTP`,
    { timeout: 60_000 },
    async () => {
      const base = await mkdtemp(join(tmpdir(), 'fidelity-browser-e2e-'));
      let owner: BrowserContext | undefined;
      let sentinel: import('playwright').Page | undefined;
      let cdpEndpoint: string | undefined;
      if (attach) {
        const profile = join(base, 'synthetic-everyday-profile');
        owner = await chromium.launchPersistentContext(profile, {
          headless: true,
          channel: 'chromium',
          args: ['--remote-debugging-port=0'],
        });
        const [port, path] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8'))
          .trim()
          .split('\n');
        cdpEndpoint = `ws://127.0.0.1:${port}${path}`;
        sentinel = await owner.newPage();
        await sentinel.setContent('<title>Unrelated tab</title>');
      }
      const bridge = new BrowserBridge(base, {
        headless: true,
        channel: 'chromium',
        attach,
        ...(cdpEndpoint ? { cdpEndpoint } : {}),
      });
      const mcp = createServer(bridge);
      let mode = 'normal';
      const calls: string[][] = [];
      let blocked = 0;
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
      ];
      async function tool(name: string, args: Record<string, unknown> = {}) {
        const response = await mcp.fetch(
          new Request('http://127.0.0.1/mcp', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json, text/event-stream',
              'MCP-Protocol-Version': '2026-07-28',
              'Mcp-Method': 'tools/call',
              'Mcp-Name': name,
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: {
                name,
                arguments: args,
                _meta: {
                  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                  'io.modelcontextprotocol/clientCapabilities': {},
                  'io.modelcontextprotocol/clientInfo': { name: 'browser-e2e', version: '1' },
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
        await bridge.start();
        // Private test instrumentation installs synthetic HTTP before any navigation.
        const context = (bridge as unknown as { context: BrowserContext }).context;
        await context.route('**/*', async (route) => {
          const request = route.request();
          const url = new URL(request.url());
          if (url.origin !== 'https://digital.fidelity.com') {
            blocked++;
            await route.abort();
            return;
          }
          if (url.pathname.startsWith('/ftgw/digital/portfolio/')) {
            await route.fulfill({
              contentType: 'text/html',
              body: `<script>window.PortSumContainer={PicoService:{getPersonContext:async()=>(${JSON.stringify({ person: { assets } })})}};</script>`,
            });
            return;
          }
          if (mode === 'expired') {
            await route.fulfill({ status: 401, body: '' });
            return;
          }
          if (url.pathname.endsWith('/balwebex/')) {
            await route.fulfill({ body: 'window.balExpConfig={"ctoken":"synthetic-csrf"};' });
            return;
          }
          if (url.search === '?snippet=Y') {
            await route.fulfill({
              body: 'window.posweb={"ctoken":"synthetic-csrf","user":"synthetic-customer"};',
            });
            return;
          }
          assert.equal(request.method(), 'POST');
          assert.equal(request.headers()['x-csrf-token'], 'synthetic-csrf');
          const body = request.postDataJSON();
          const balance = url.pathname.endsWith('/balances');
          const decoded = JSON.parse(
            gunzipSync(Buffer.from(balance ? body.picoString : body.pico, 'base64')).toString(),
          );
          const ids: string[] = balance ? decoded.map((a: any) => a.account.acctNum) : body.accts;
          assert.ok(ids.length && ids.every((id) => ['TEST1234', 'NEXT1234'].includes(id)));
          calls.push(ids);
          const payload = balance
            ? ids.map((id, i) => ({
                account: { acctNum: id },
                balance: { totalAcctVal: i ? '0.20' : '0.10' },
              }))
            : {
                totalNoOfAccts: mode === 'incomplete' ? 0 : ids.length,
                acctTot: ids.map((id) => ({ acctNum: id })),
                rowData: ids.flatMap((id) => [
                  { rowType: 'ACCOUNT', actNum: id },
                  {
                    rowType: 'POSITION',
                    actNum: id,
                    sym: { name: 'TEST', desc: 'Synthetic holding' },
                    qty: { val: '1.12345678' },
                    curVal: { val: '13.87' },
                  },
                ]),
              };
          await route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
        });
        await bridge.connectFidelity(new AbortController().signal);
        const accounts = (await tool('fidelity_list_accounts')).structuredContent.accounts;
        assert.equal(accounts.length, 2);
        assert.equal(accounts[0].last4, accounts[1].last4);
        assert.notEqual(accounts[0].accountId, accounts[1].accountId);
        const accountId = accounts[0].accountId;
        const all = (await tool('fidelity_get_account_balance')).structuredContent;
        assert.equal(all.totalAccountValue, '0.30');
        const one = (await tool('fidelity_get_account_balance', { accountId })).structuredContent;
        assert.equal(one.accounts.length, 1);
        assert.deepEqual(calls.at(-1), ['TEST1234']);
        const holdings = (await tool('fidelity_get_positions', { accountId })).structuredContent;
        assert.equal(holdings.accounts[0].positions[0].quantity, '1.12345678');
        const before = calls.length;
        assert.match(
          JSON.stringify(
            await tool('fidelity_get_positions', { accountId: 'acct_' + 'f'.repeat(32) }),
          ),
          /ACCOUNT_NOT_FOUND/,
        );
        assert.equal(calls.length, before);
        assert.ok((await tool('fidelity_get_positions', { accountId: 'TEST1234' })).error);
        for (const failure of ['incomplete', 'expired']) {
          mode = failure;
          const result = await tool('fidelity_get_positions');
          assert.equal(result.isError, true);
          assert.equal(result.structuredContent, undefined);
          assert.match(
            JSON.stringify(result),
            failure === 'expired' ? /AUTHENTICATION_REQUIRED/ : /API_RESPONSE_CHANGED/,
          );
        }
        mode = 'normal';
        const page = context.pages().find((p) => p.url().includes('/portfolio/'))!;
        await page.reload();
        assert.equal(
          (await tool('fidelity_list_accounts')).structuredContent.accounts[0].accountId,
          accountId,
        );
        const replacement = await context.newPage();
        await replacement.goto(page.url());
        await page.close();
        assert.equal(
          (await tool('fidelity_list_accounts')).structuredContent.accounts[0].accountId,
          accountId,
        );
        assert.doesNotMatch(
          JSON.stringify([all, one, holdings, accounts]),
          /TEST1234|NEXT1234|HIDE5678|synthetic-csrf|synthetic-customer|picoString/,
        );
        await replacement.goto('https://example.test/').catch(() => {});
        assert.equal((await tool('fidelity_list_accounts')).isError, true);
        assert.ok(blocked > 0);
        const ownerTabs = owner?.pages();
        await bridge.close();
        assert.equal((await tool('fidelity_list_accounts')).isError, true);
        if (attach) {
          assert.equal(
            owner!.browser()!.isConnected(),
            true,
            'Detach keeps everyday Chrome running.',
          );
          assert.equal(sentinel!.isClosed(), false, 'Detach preserves unrelated tabs.');
          assert.equal(await sentinel!.title(), 'Unrelated tab');
          assert.deepEqual(
            owner!.pages(),
            ownerTabs,
            'Detach preserves all existing browser tabs.',
          );
        }
        const adapterHash = createHash('sha256')
          .update(await readFile('dist/bridge/browser-adapter.js'))
          .digest('hex');
        await mkdir('artifacts', { recursive: true });
        await writeFile(
          attach ? 'artifacts/browser-attach-e2e.json' : 'artifacts/browser-e2e.json',
          JSON.stringify(
            {
              passed: true,
              generatedAt: new Date().toISOString(),
              repeat: 'npm test',
              adapterHash,
              runtime: `real headless Chromium; ${attach ? 'CDP attach/detach; existing browser survives' : 'owned browser'}; MCP handler; bundled adapter; intercepted synthetic Fidelity HTTP; no extension/native host`,
              liveFidelityValidated: false,
              checks: [
                'readiness',
                'all and single account reads',
                'gzip and runtime CSRF bootstrap',
                'opaque collision-safe account references',
                'precision',
                'unknown accounts do not call provider',
                'incomplete responses and session expiry',
                'reload and closed-tab recovery',
                'foreign origin refused',
                'browser closure fails safely',
                'credentials and full identifiers absent from tool results',
              ],
            },
            null,
            2,
          ) + '\n',
        );
      } finally {
        await bridge.close();
        await mcp.close();
        await owner?.close();
        await rm(base, { recursive: true, force: true });
      }
    },
  );
