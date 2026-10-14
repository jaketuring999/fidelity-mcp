import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { startHttpServer } from '../../dist/server/http.js';
import { createServer } from '../../dist/server/mcp.js';
import { BrowserBridge } from '../../dist/bridge/browser-bridge.js';
import { chromium } from 'playwright';
import { revokeLocalAccess } from '../../dist/server/auth.js';
import {
  auth,
  Client,
  StreamableHTTPClientTransport,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from '@modelcontextprotocol/client';

function send(url: string, method = 'GET', body = '', headers: Record<string, string> = {}) {
  return new Promise<{
    status: number;
    headers: import('node:http').IncomingHttpHeaders;
    text: string;
    json: any;
  }>((resolve, reject) => {
    const req = request(url, { method, headers, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        text += chunk;
      });
      res.once('error', reject);
      res.once('end', () => {
        let json: unknown;
        try {
          json = res.headers['content-type']?.includes('text/event-stream')
            ? text
                .split('\n')
                .filter((line) => line.startsWith('data:'))
                .map((line) => JSON.parse(line.slice(5)))
                .find((item) => 'result' in item || 'error' in item)
            : JSON.parse(text);
        } catch {
          /* HTML or empty response */
        }
        resolve({ status: res.statusCode!, headers: res.headers, text, json });
      });
    });
    req.setTimeout(10_000, () => req.destroy(new Error('HTTP request timed out')));
    req.once('error', reject);
    req.end(body);
  });
}
const meta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'oauth-e2e', version: '1' },
};
function rpc(method: string, params: Record<string, unknown> = {}) {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: meta } });
}
const rpcHeaders = (method: string, token?: string, name?: string) => ({
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  'MCP-Protocol-Version': '2026-07-28',
  'Mcp-Method': method,
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
  ...(name ? { 'Mcp-Name': name } : {}),
});
async function eventually<T>(read: () => Promise<T | undefined>): Promise<T> {
  for (let attempt = 0; attempt < 150; attempt++) {
    const result = await read();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Expected flow did not complete.');
}

test(
  'OAuth over loopback HTTP → CDP browser → Fidelity ready → automatic callback → MCP balance, refresh, restart and revocation',
  { timeout: 60_000 },
  async () => {
    const base = await mkdtemp(join(tmpdir(), 'fidelity-oauth-e2e-'));
    const evidence: string[] = [];
    const profile = join(base, 'synthetic-chrome');
    const owner = await chromium.launchPersistentContext(profile, {
      headless: true,
      channel: 'chromium',
      args: ['--remote-debugging-port=0'],
    });
    const { readFile } = await import('node:fs/promises');
    const [port, path] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8'))
      .trim()
      .split('\n');
    const bridge = new BrowserBridge(base, {
      attach: true,
      cdpEndpoint: `ws://127.0.0.1:${port}${path}`,
    });
    let balanceReads = 0;
    let ready = false;
    let mode: 'balance' | 'expired' = 'balance';
    const connections: Array<{ controller: AbortController }> = [];
    let endpoint: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    const connectFidelity = (signal: AbortSignal) => {
      ready = false;
      const controller = new AbortController();
      connections.push({ controller });
      return bridge.connectFidelity(AbortSignal.any([signal, controller.signal]));
    };
    try {
      await bridge.start();
      const context = (bridge as unknown as { context: import('playwright').BrowserContext })
        .context;
      await context.exposeFunction('syntheticPerson', () => {
        if (!ready) throw new Error('Synthetic sign-in is pending.');
        return {
          person: {
            assets: [
              {
                acctNum: 'TEST1234',
                acctType: 'Brokerage',
                preferenceDetail: { name: 'Synthetic account' },
              },
            ],
          },
        };
      });
      await context.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== 'https://digital.fidelity.com') {
          await route.abort();
        } else if (request.isNavigationRequest()) {
          await route.fulfill({
            contentType: 'text/html',
            body: '<script>window.PortSumContainer={PicoService:{getPersonContext:()=>window.syntheticPerson()}};</script>',
          });
        } else if (mode === 'expired') {
          await route.fulfill({ status: 401, body: '' });
        } else if (url.pathname.endsWith('/balwebex/')) {
          await route.fulfill({ body: 'window.balExpConfig={"ctoken":"synthetic-csrf"};' });
        } else if (url.pathname.endsWith('/balances')) {
          balanceReads++;
          await route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify([
              { account: { acctNum: 'TEST1234' }, balance: { totalAcctVal: '42.00' } },
            ]),
          });
        } else {
          await route.abort();
        }
      });
      evidence.push(
        'Real Chromium connected over CDP; bundled adapter reads intercepted synthetic Fidelity HTTP.',
      );
      endpoint = await startHttpServer(createServer(bridge), {
        base,
        port: 0,
        connectFidelity,
      });
      const origin = new URL(endpoint.url).origin;
      const get = (path: string) => send(new URL(path, origin).href);
      const form = (path: string, values: Record<string, string>) =>
        send(new URL(path, origin).href, 'POST', new URLSearchParams(values).toString(), {
          'Content-Type': 'application/x-www-form-urlencoded',
        });
      const call = (method: string, token?: string, params: Record<string, unknown> = {}) =>
        send(
          endpoint!.url,
          'POST',
          rpc(method, params),
          rpcHeaders(method, token, params.name as string | undefined),
        );
      assert.equal((await fetch(endpoint.url)).status, 401);
      evidence.push('Plain Node fetch reaches loopback HTTP without certificate configuration.');
      const challenge = await call('tools/list');
      assert.equal(challenge.status, 401);
      const resourceUrl = /resource_metadata="([^"]+)"/.exec(
        challenge.headers['www-authenticate']!,
      )?.[1];
      assert.ok(resourceUrl);
      const resource = (await send(resourceUrl)).json;
      assert.equal(resource.resource, endpoint.url);
      const discovery = (await get('/.well-known/oauth-authorization-server')).json;
      assert.equal(discovery.issuer, origin);
      assert.equal(discovery.client_id_metadata_document_supported, true);
      assert.ok(discovery.code_challenge_methods_supported.includes('S256'));
      assert.deepEqual(discovery.dpop_signing_alg_values_supported, []);
      evidence.push('401 discovery advertises resource, PKCE S256, CIMD and OAuth endpoints.');
      const registered = await send(
        discovery.registration_endpoint,
        'POST',
        JSON.stringify({
          client_name: 'Cursor',
          redirect_uris: [
            'https://www.cursor.com/agents/mcp/oauth/callback',
            'http://127.0.0.1:8090/callback',
          ],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        }),
        { 'Content-Type': 'application/json' },
      );
      assert.equal(registered.status, 201, registered.text);
      assert.equal(registered.json.application_type, 'native');
      assert.deepEqual(registered.json.redirect_uris, [
        'https://www.cursor.com/agents/mcp/oauth/callback',
        'http://127.0.0.1:8090/callback',
      ]);
      evidence.push(
        'Cursor-style mixed hosted/loopback registration without application_type succeeds as a public native PKCE client.',
      );
      const clientId = registered.json.client_id;
      assert.equal(
        (
          await send(
            discovery.registration_endpoint,
            'POST',
            JSON.stringify({
              redirect_uris: ['https://evil.test/callback'],
              token_endpoint_auth_method: 'none',
            }),
            { 'Content-Type': 'application/json' },
          )
        ).status,
        400,
      );
      for (const redirect of [
        'https://www.cursor.com/agents/mcp/oauth/callback/evil',
        'https://www.cursor.com/agents/mcp/oauth/callback?next=evil',
        'https://www.cursor.com.evil.test/agents/mcp/oauth/callback',
      ]) {
        assert.equal(
          (
            await send(
              discovery.registration_endpoint,
              'POST',
              JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: 'none' }),
              { 'Content-Type': 'application/json' },
            )
          ).status,
          400,
        );
      }
      async function begin(redirectUri = 'http://127.0.0.1:8090/callback') {
        const verifier = randomBytes(32).toString('base64url');
        const authorize = new URL(discovery.authorization_endpoint);
        authorize.search = new URLSearchParams({
          response_type: 'code',
          client_id: clientId,
          redirect_uri: redirectUri,
          scope: 'fidelity:portfolio:read offline_access',
          state: 'synthetic-state',
          resource: endpoint!.url,
          code_challenge: createHash('sha256').update(verifier).digest('base64url'),
          code_challenge_method: 'S256',
        }).toString();
        const first = await send(authorize.href);
        assert.equal(first.status, 302, first.text);
        assert.equal(first.headers['set-cookie'], undefined);
        assert.ok(
          Number(new URL(first.headers.location!, origin).searchParams.get('exp')) * 1000 -
            Date.now() >
            5 * 60_000,
          'OAuth connection must leave enough time for Fidelity 2FA.',
        );
        const response = send(new URL(first.headers.location!, origin).href);
        const connection = await eventually(async () => connections.shift());
        return { verifier, response, connection };
      }
      async function finish(
        flow: { response: ReturnType<typeof send>; connection: { controller: AbortController } },
        authenticated: boolean,
      ) {
        if (authenticated) {
          // Release synthetic sign-in; the real adapter must establish readiness.
          ready = true;
        } else {
          flow.connection.controller.abort();
        }
        const response = await flow.response;
        assert.equal(response.status, 302, response.text);
        assert.equal(response.text, '');
        assert.equal(response.headers['set-cookie'], undefined);
        return new URL(response.headers.location!);
      }
      const waiting = await begin();
      assert.equal((await get('/oauth/status')).status, 404);
      assert.equal((await send(`${origin}/oauth/retry`, 'POST')).status, 404);
      assert.equal(
        (
          await call('tools/call', undefined, {
            name: 'fidelity_get_account_balance',
            arguments: {},
          })
        ).status,
        401,
      );
      assert.equal((await send(`${origin}/auth/local-owner-session`, 'POST')).status, 404);
      assert.equal((await form('/auth/oauth2/consent', { accept: 'true' })).status, 404);
      assert.equal((await get('/connect?client_id=fake')).status, 400);
      const denied = await finish(waiting, false);
      assert.equal(denied.searchParams.get('error'), 'temporarily_unavailable');
      assert.equal(denied.searchParams.get('state'), 'synthetic-state');
      assert.equal(denied.searchParams.get('code'), null);
      assert.equal(balanceReads, 0);
      evidence.push(
        'No approval UI or HTTP owner-session bypass; unavailable Fidelity yields no token or balance access.',
      );
      const cursorFlow = await begin('https://www.cursor.com/agents/mcp/oauth/callback');
      const cursorCallback = await finish(cursorFlow, true);
      assert.equal(cursorCallback.origin, 'https://www.cursor.com');
      assert.equal(cursorCallback.pathname, '/agents/mcp/oauth/callback');
      assert.ok(cursorCallback.searchParams.get('code'));
      const cursorTokens = await form(new URL(discovery.token_endpoint).pathname, {
        grant_type: 'authorization_code',
        client_id: clientId,
        redirect_uri: 'https://www.cursor.com/agents/mcp/oauth/callback',
        code: cursorCallback.searchParams.get('code')!,
        code_verifier: cursorFlow.verifier,
        resource: endpoint.url,
      });
      assert.equal(cursorTokens.status, 200, cursorTokens.text);
      assert.equal((await call('tools/list', cursorTokens.json.access_token)).status, 200);
      evidence.push(
        'Cursor hosted callback completes through browser Fidelity readiness; lookalike and modified remote callbacks are rejected.',
      );
      const flow = await begin();
      const callback = await finish(flow, true);
      assert.equal(callback.searchParams.get('iss'), origin);
      assert.equal(callback.searchParams.get('state'), 'synthetic-state');
      const exchangeValues = {
        grant_type: 'authorization_code',
        client_id: clientId,
        redirect_uri: 'http://127.0.0.1:8090/callback',
        code: callback.searchParams.get('code')!,
        code_verifier: flow.verifier,
        resource: endpoint.url,
      };
      const exchanged = await form(new URL(discovery.token_endpoint).pathname, exchangeValues);
      assert.equal(exchanged.status, 200, exchanged.text);
      let tokens = exchanged.json;
      assert.ok(tokens.refresh_token);
      const listed = await call('tools/list', tokens.access_token);
      assert.equal(listed.status, 200, listed.text);
      assert.equal(listed.headers['mcp-session-id'], undefined);
      assert.deepEqual(
        listed.json.result.tools.map((tool: { name: string }) => tool.name),
        [
          'fidelity_list_accounts',
          'fidelity_get_account_balance',
          'fidelity_get_positions',
          'fidelity_get_tax_lots',
          'fidelity_get_performance',
          'fidelity_get_balance_history',
        ],
      );
      const balances = await call('tools/call', tokens.access_token, {
        name: 'fidelity_get_account_balance',
        arguments: {},
      });
      assert.equal(balances.status, 200);
      assert.equal(balances.json.result.structuredContent.totalAccountValue, '42.00');
      assert.equal(balances.headers['mcp-session-id'], undefined);
      mode = 'expired';
      assert.match(
        (
          await call('tools/call', tokens.access_token, {
            name: 'fidelity_get_account_balance',
            arguments: {},
          })
        ).text,
        /AUTHENTICATION_REQUIRED/,
      );
      mode = 'balance';
      evidence.push(
        'Browser Fidelity readiness enables a real modern MCP balance call without initialize or session ID; Fidelity expiry returns an explicit tool error.',
      );
      for (const method of ['GET', 'DELETE'])
        assert.equal(
          (await send(endpoint.url, method, '', { Authorization: `Bearer ${tokens.access_token}` }))
            .status,
          405,
        );
      assert.equal(
        (
          await send(endpoint.url, 'POST', rpc('tools/list'), {
            ...rpcHeaders('tools/list', tokens.access_token),
            Origin: 'https://evil.test',
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await send(endpoint.url, 'POST', rpc('tools/list'), {
            ...rpcHeaders('tools/list', tokens.access_token),
            Host: 'evil.test',
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await send(
            endpoint.url,
            'POST',
            'x'.repeat(70_000),
            rpcHeaders('tools/list', tokens.access_token),
          )
        ).status,
        413,
      );
      const port = Number(new URL(endpoint.url).port);
      await endpoint.close();
      endpoint = await startHttpServer(createServer(bridge), {
        base,
        port,
        connectFidelity,
      });
      assert.equal((await call('tools/list', tokens.access_token)).status, 200);
      const oldRefresh = tokens.refresh_token;
      const refreshed = await form(new URL(discovery.token_endpoint).pathname, {
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: oldRefresh,
        resource: endpoint.url,
        scope: 'fidelity:portfolio:read',
      });
      assert.equal(refreshed.status, 200, refreshed.text);
      tokens = refreshed.json;
      assert.notEqual(tokens.refresh_token, oldRefresh);
      assert.equal((await call('tools/list', tokens.access_token)).status, 200);
      assert.equal(
        (
          await form(new URL(discovery.token_endpoint).pathname, {
            grant_type: 'refresh_token',
            client_id: clientId,
            refresh_token: oldRefresh,
            resource: endpoint.url,
          })
        ).status,
        400,
      );
      assert.equal((await call('tools/list', tokens.access_token)).status, 401);
      evidence.push(
        'Client registration, keys and grants survive server restart; refresh rotates tokens and rejects replay even after narrowing access scopes.',
      );
      const badPkceFlow = await begin();
      const badPkceCallback = await finish(badPkceFlow, true);
      assert.equal(
        (
          await form(new URL(discovery.token_endpoint).pathname, {
            ...exchangeValues,
            code: badPkceCallback.searchParams.get('code')!,
            code_verifier: randomBytes(32).toString('base64url'),
          })
        ).status,
        401,
      );
      // A separate grant verifies code replay without revoking the restart grant.
      const replayFlow = await begin();
      const replayCallback = await finish(replayFlow, true);
      const replayExchange = {
        ...exchangeValues,
        code: replayCallback.searchParams.get('code')!,
        code_verifier: replayFlow.verifier,
      };
      const replayTokens = await form(new URL(discovery.token_endpoint).pathname, replayExchange);
      assert.equal(replayTokens.status, 200, replayTokens.text);
      assert.equal(
        (await form(new URL(discovery.token_endpoint).pathname, replayExchange)).status,
        400,
      );
      assert.equal((await call('tools/list', replayTokens.json.access_token)).status, 401);
      evidence.push(
        'Wrong PKCE verifier and authorization-code replay are rejected; replay invalidates the issued grant.',
      );

      // The official SDK performs its own discovery, registration, PKCE and
      // token exchange. Only Chrome's Fidelity readiness is simulated here.
      let sdkClientInfo: StoredOAuthClientInformation | undefined;
      let sdkTokens: StoredOAuthTokens | undefined;
      let sdkDiscovery: OAuthDiscoveryState | undefined;
      let sdkVerifier = '',
        authorizationUrl: URL | undefined;
      const provider: OAuthClientProvider = {
        redirectUrl: 'http://127.0.0.1:8091/callback',
        clientMetadata: {
          client_name: 'Official SDK agent',
          redirect_uris: ['http://127.0.0.1:8091/callback'],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
          scope: 'fidelity:portfolio:read offline_access',
        },
        state: () => 'sdk-state',
        clientInformation: () => sdkClientInfo,
        saveClientInformation: (value) => {
          sdkClientInfo = value;
        },
        tokens: () => sdkTokens,
        saveTokens: (value) => {
          sdkTokens = value;
        },
        codeVerifier: () => sdkVerifier,
        saveCodeVerifier: (value) => {
          sdkVerifier = value;
        },
        redirectToAuthorization: (value) => {
          authorizationUrl = value;
        },
        discoveryState: () => sdkDiscovery,
        saveDiscoveryState: (value) => {
          sdkDiscovery = value;
        },
      };
      const fetchFn: typeof fetch = async (input, init) => {
        const req = new Request(input, init);
        const response = await send(
          req.url,
          req.method,
          ['GET', 'HEAD'].includes(req.method) ? '' : await req.text(),
          Object.fromEntries(req.headers),
        );
        const headers = new Headers();
        for (const [key, value] of Object.entries(response.headers))
          if (value !== undefined)
            for (const entry of Array.isArray(value) ? value : [value]) headers.append(key, entry);
        return new Response(response.text, { status: response.status, headers });
      };
      assert.equal(
        await auth(provider, {
          serverUrl: endpoint.url,
          fetchFn,
          scope: 'fidelity:portfolio:read offline_access',
        }),
        'REDIRECT',
      );
      assert.ok(authorizationUrl);
      const sdkRedirect = await send(authorizationUrl.href);
      assert.equal(sdkRedirect.status, 302, sdkRedirect.text);
      const sdkResponse = send(new URL(sdkRedirect.headers.location!, origin).href);
      const sdkConnection = await eventually(async () => connections.shift());
      const sdkCallback = await finish({ response: sdkResponse, connection: sdkConnection }, true);
      assert.equal(sdkCallback.searchParams.get('state'), 'sdk-state');
      assert.equal(
        await auth(provider, {
          serverUrl: endpoint.url,
          fetchFn,
          authorizationCode: sdkCallback.searchParams.get('code')!,
          iss: sdkCallback.searchParams.get('iss')!,
        }),
        'AUTHORIZED',
      );
      const sdkClient = new Client(
        { name: 'official-sdk-e2e', version: '1' },
        { versionNegotiation: { mode: { pin: '2026-07-28' } } },
      );
      const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
        authProvider: provider,
        fetch: fetchFn,
      });
      try {
        await sdkClient.connect(transport);
        assert.deepEqual(
          (await sdkClient.listTools()).tools.map((tool) => tool.name),
          [
            'fidelity_list_accounts',
            'fidelity_get_account_balance',
            'fidelity_get_positions',
            'fidelity_get_tax_lots',
            'fidelity_get_performance',
            'fidelity_get_balance_history',
          ],
        );
        assert.equal(
          (await sdkClient.callTool({ name: 'fidelity_get_account_balance', arguments: {} }))
            .structuredContent?.totalAccountValue,
          '42.00',
        );
        assert.equal(transport.sessionId, undefined);
      } finally {
        await sdkClient.close();
      }
      assert.ok(sdkTokens?.refresh_token);
      assert.equal(await auth(provider, { serverUrl: endpoint.url, fetchFn }), 'AUTHORIZED');
      evidence.push(
        'Official MCP SDK v2 discovers OAuth, registers, exchanges PKCE, calls the modern tool and refreshes automatically.',
      );
      for (const name of ['auth-secret', 'auth.sqlite'])
        assert.equal((await stat(join(base, name))).mode & 0o777, 0o600);
      const finalFlow = await begin();
      const finalCallback = await finish(finalFlow, true);
      const finalExchange = {
        grant_type: 'authorization_code',
        client_id: clientId,
        redirect_uri: 'http://127.0.0.1:8090/callback',
        code: finalCallback.searchParams.get('code')!,
        code_verifier: finalFlow.verifier,
        resource: endpoint.url,
      };
      const finalTokens = await form(new URL(discovery.token_endpoint).pathname, finalExchange);
      assert.equal(finalTokens.status, 200, finalTokens.text);
      tokens = finalTokens.json;
      assert.equal((await call('tools/list', tokens.access_token)).status, 200);
      revokeLocalAccess(base);
      assert.equal((await call('tools/list', tokens.access_token)).status, 401);
      assert.equal(
        (
          await form(new URL(discovery.token_endpoint).pathname, {
            grant_type: 'refresh_token',
            client_id: clientId,
            refresh_token: tokens.refresh_token,
            resource: endpoint.url,
          })
        ).status,
        400,
      );
      evidence.push('revoke-access invalidates access and refresh grants.');
      await mkdir('artifacts', { recursive: true });
      await writeFile(
        'artifacts/oauth-e2e.json',
        JSON.stringify(
          {
            passed: true,
            generatedAt: new Date().toISOString(),
            repeat: 'npm test',
            environment: { node: process.version, platform: process.platform },
            fidelityData: 'synthetic',
            connection:
              'real Chromium CDP connection and bundled adapter; intercepted synthetic Fidelity HTTP; automatic OAuth callback',
            transport: 'loopback HTTP + MCP 2026-07-28',
            checks: evidence,
          },
          null,
          2,
        ) + '\n',
      );
    } finally {
      await endpoint?.close();
      await bridge.close();
      await owner.close();
      await rm(base, { recursive: true, force: true });
    }
  },
);
