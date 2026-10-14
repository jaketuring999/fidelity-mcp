// One-shot OAuth integration check. No token or balance data is printed or saved.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  accountsResultSchema,
  positionsResultSchema,
  accountIdSchema,
  taxLotsResultSchema,
  performanceResultSchema,
  balanceHistoryResultSchema,
} from '../src/bridge/protocol.js';
import {
  auth,
  Client,
  StreamableHTTPClientTransport,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from '@modelcontextprotocol/client';

const serverUrl = `http://127.0.0.1:${process.env.MCP_PORT ?? '3443'}/mcp`;
const bridgeMode = process.env.FIDELITY_BRIDGE === 'browser' ? 'browser' : 'browser-attach';
let clientInfo: StoredOAuthClientInformation | undefined;
let tokens: StoredOAuthTokens | undefined;
let discovery: OAuthDiscoveryState | undefined;
let verifier = '';
const state = randomBytes(32).toString('base64url');
let finish!: (url: URL) => void;
let fail!: (error: Error) => void;
const callback = new Promise<URL>((resolve, reject) => {
  finish = resolve;
  fail = reject;
});
const listener = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname !== '/callback' || url.searchParams.get('state') !== state) {
    res.writeHead(400).end('Invalid callback.');
    return;
  }
  res
    .writeHead(200, {
      'Content-Type': 'text/plain',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    })
    .end('Authorization received. Return to the local test terminal.');
  finish(url);
});
await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
const address = listener.address();
if (!address || typeof address === 'string') throw new Error('Callback listener unavailable.');
const redirectUrl = `http://127.0.0.1:${address.port}/callback`;
const provider: OAuthClientProvider = {
  redirectUrl,
  clientMetadata: {
    client_name: 'Fidelity MCP local live check',
    redirect_uris: [redirectUrl],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: 'fidelity:portfolio:read offline_access',
  },
  state: () => state,
  clientInformation: () => clientInfo,
  saveClientInformation: (value) => {
    clientInfo = value;
  },
  tokens: () => tokens,
  saveTokens: (value) => {
    tokens = value;
  },
  codeVerifier: () => verifier,
  saveCodeVerifier: (value) => {
    verifier = value;
  },
  discoveryState: () => discovery,
  saveDiscoveryState: (value) => {
    discovery = value;
  },
  redirectToAuthorization: (url) => {
    console.log(`Checking automatic local OAuth callback with Chrome browser bridge.`);
    void (async () => {
      let next = url;
      for (let redirects = 0; redirects < 5; redirects++) {
        const response = await fetch(next, {
          redirect: 'manual',
          signal: AbortSignal.timeout(300_000),
        });
        console.log(`Local OAuth ${next.pathname}: ${response.status}`);
        if (response.status === 302 && response.headers.has('location')) {
          next = new URL(response.headers.get('location')!, next);
          continue;
        }
        if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
          const body = await response.json();
          const redirect = z.object({ url: z.string(), redirect: z.literal(true) }).safeParse(body);
          if (redirect.success) {
            const target = new URL(redirect.data.url, next);
            if (target.origin !== new URL(serverUrl).origin || target.pathname !== '/connect')
              throw new Error('Unexpected local authorization redirect.');
            next = target;
            continue;
          }
          throw new Error('Unexpected local authorization response.');
        }
        if (!response.ok) throw new Error('Automatic local callback failed.');
        return;
      }
      throw new Error('Too many local OAuth redirects.');
    })().catch(() => fail(new Error('Automatic local callback failed.')));
  },
};
const client = new Client(
  { name: 'fidelity-live-check', version: '1' },
  { versionNegotiation: { mode: { pin: '2026-07-28' } } },
);
const timeout = setTimeout(
  () => fail(new Error('Fidelity connection timed out. Run the live check again.')),
  5 * 60_000,
);
let revoked = false;
async function revokeTestGrant() {
  if (!tokens?.refresh_token || !clientInfo || revoked) return;
  const response = await fetch(new URL('/auth/oauth2/revoke', serverUrl), {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      token: tokens.refresh_token,
      token_type_hint: 'refresh_token',
      client_id: clientInfo.client_id,
    }),
  });
  if (!response.ok)
    throw new Error('Could not revoke the one-time test grant. Run fidelity-mcp revoke-access.');
  revoked = true;
}
try {
  if (
    (await auth(provider, { serverUrl, scope: 'fidelity:portfolio:read offline_access' })) !==
    'REDIRECT'
  )
    throw new Error('Expected browser authorization.');
  const url = await callback;
  if (url.searchParams.has('error')) throw new Error('Fidelity connection did not complete.');
  const code = url.searchParams.get('code');
  if (!code) throw new Error('No authorization code.');
  await auth(provider, {
    serverUrl,
    authorizationCode: code,
    iss: url.searchParams.get('iss') ?? '',
  });
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    authProvider: provider,
  });
  await client.connect(transport);
  const toolNames = (await client.listTools()).tools.map((tool) => tool.name);
  if (
    JSON.stringify(toolNames) !==
    JSON.stringify([
      'fidelity_list_accounts',
      'fidelity_get_account_balance',
      'fidelity_get_positions',
      'fidelity_get_tax_lots',
      'fidelity_get_performance',
      'fidelity_get_balance_history',
    ])
  )
    throw new Error('Unexpected tool set. Rebuild and restart the browser bridge and server.');
  const accountResult = await client.callTool({ name: 'fidelity_list_accounts', arguments: {} });
  const listed = accountsResultSchema.safeParse(accountResult.structuredContent);
  if (accountResult.isError || !listed.success || !listed.data.accounts.length)
    throw new Error('Live accounts check failed.');
  const accountId = listed.data.accounts[0]!.accountId;
  const result = await client.callTool({ name: 'fidelity_get_account_balance', arguments: {} });
  const value = z
    .object({
      source: z.literal('fidelity_internal_api'),
      totalAccountValue: z.string().regex(/^\d+\.\d{2}$/),
      accounts: z.array(z.unknown()).min(1),
    })
    .safeParse(result.structuredContent);
  if (result.isError || !value.success)
    throw new Error('Live balance check failed. Check your Fidelity connection.');
  const singleBalance = await client.callTool({
    name: 'fidelity_get_account_balance',
    arguments: { accountId },
  });
  const selectedBalance = z
    .object({ accounts: z.array(z.object({ accountId: accountIdSchema })).length(1) })
    .safeParse(singleBalance.structuredContent);
  if (
    singleBalance.isError ||
    !selectedBalance.success ||
    selectedBalance.data.accounts[0]!.accountId !== accountId
  )
    throw new Error('Single-account balance check failed.');
  let allPositions: z.infer<typeof positionsResultSchema> | undefined;
  for (const args of [{}, { accountId }]) {
    const result = await client.callTool({ name: 'fidelity_get_positions', arguments: args });
    const parsed = positionsResultSchema
      .extend({
        source: z.literal('fidelity_internal_api'),
        scope: z.enum(['all_visible_brokerage_accounts', 'specific_brokerage_account']),
        currency: z.literal('USD'),
        freshnessNote: z.string(),
      })
      .safeParse(result.structuredContent);
    if (result.isError || !parsed.success) throw new Error('Live positions check failed.');
    if (!('accountId' in args)) allPositions = parsed.data;
    const expected =
      'accountId' in args ? [accountId] : listed.data.accounts.map((a) => a.accountId);
    if (
      JSON.stringify(parsed.data.accounts.map((a) => a.accountId).sort()) !==
      JSON.stringify(expected.sort())
    )
      throw new Error('Live positions account scope mismatch.');
  }
  const selections = [{}, ...listed.data.accounts.map((a) => ({ accountId: a.accountId }))];
  const checkScope = (accounts: Array<{ accountId: string }>, args: { accountId?: string }) => {
    const expected = args.accountId
      ? [args.accountId]
      : listed.data.accounts.map((a) => a.accountId);
    if (JSON.stringify(accounts.map((a) => a.accountId).sort()) !== JSON.stringify(expected.sort()))
      throw new Error('Advanced live read account scope mismatch.');
  };
  for (const args of selections) {
    const result = await client.callTool({ name: 'fidelity_get_performance', arguments: args });
    const parsed = performanceResultSchema.passthrough().safeParse(result.structuredContent);
    if (result.isError || !parsed.success) throw new Error('Live performance schema check failed.');
    checkScope(parsed.data.accounts, args);
    for (const range of ['1M', 'YTD', '1Y', '3Y'] as const) {
      const history = await client.callTool({
        name: 'fidelity_get_balance_history',
        arguments: { ...args, range },
      });
      const parsedHistory = balanceHistoryResultSchema
        .passthrough()
        .safeParse(history.structuredContent);
      if (history.isError || !parsedHistory.success || parsedHistory.data.range !== range)
        throw new Error('Live balance history schema/range check failed.');
      checkScope(parsedHistory.data.accounts, args);
    }
  }
  let availableLotHoldings = 0;
  for (const account of allPositions!.accounts) {
    for (const symbol of new Set(account.positions.map((p) => p.symbol))) {
      const result = await client.callTool({
        name: 'fidelity_get_tax_lots',
        arguments: { accountId: account.accountId, symbol },
      });
      const parsed = taxLotsResultSchema.passthrough().safeParse(result.structuredContent);
      if (result.isError || !parsed.success) throw new Error('Live tax-lot schema check failed.');
      checkScope(parsed.data.accounts, { accountId: account.accountId });
      for (const holding of parsed.data.accounts[0]!.positions) {
        if (holding.symbol !== symbol) throw new Error('Live tax-lot security scope mismatch.');
        if (holding.status === 'available') availableLotHoldings++;
      }
    }
  }
  const previousRefresh = tokens?.refresh_token;
  await auth(provider, { serverUrl });
  if (!previousRefresh || tokens?.refresh_token === previousRefresh)
    throw new Error('Refresh rotation failed.');
  await client.listTools();
  if (transport.sessionId !== undefined) throw new Error('Unexpected MCP session ID.');
  await revokeTestGrant();
  if (
    (
      await fetch(serverUrl, {
        headers: { Authorization: `Bearer ${tokens!.access_token}` },
        signal: AbortSignal.timeout(10_000),
      })
    ).status !== 401
  )
    throw new Error('Revoked test access was still accepted.');
  await mkdir('artifacts', { recursive: true });
  await writeFile(
    bridgeMode === 'browser-attach'
      ? 'artifacts/browser-attach-live.json'
      : 'artifacts/browser-live.json',
    JSON.stringify(
      {
        passed: true,
        generatedAt: new Date().toISOString(),
        repeat: `FIDELITY_BRIDGE=${bridgeMode} MCP_PORT=${process.env.MCP_PORT ?? '3443'} npm run check:live`,
        endpoint: serverUrl,
        client: 'official MCP SDK v2',
        transport: 'loopback HTTP, stateless 2026-07-28',
        connection: `${bridgeMode === 'browser-attach' ? 'everyday Chrome attach' : 'dedicated Chrome'} browser bridge; automatic Fidelity readiness`,
        callback: 'local HTTP client followed OAuth redirects',
        tools: toolNames,
        accounts: 'real Fidelity context; identifiers omitted',
        balance: 'real Fidelity internal API; all and single account; values omitted',
        positions: 'real Fidelity internal API; all and single account; values omitted',
        performance:
          'Canonical schemas; all and every single account; calculation metadata and unavailable periods preserved; values omitted',
        balanceHistory:
          'Canonical schemas; all four ranges; all and every single account; values omitted',
        taxLots: { everyHeldSymbolChecked: true, availableLotHoldings, valuesOmitted: true },
        remoteDebugging:
          'Uses the running MCP server; this check never opens a separate Chrome debugging connection',
        refreshRotation: true,
        testGrantRevoked: true,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'Live OAuth, six tools, all/single-account scope, all history ranges, every held symbol tax lots, typed responses, and token refresh passed. Financial values omitted.',
  );
} finally {
  clearTimeout(timeout);
  try {
    await client.close();
    await revokeTestGrant();
  } finally {
    const stopped = new Promise<void>((resolve) => listener.close(() => resolve()));
    listener.closeAllConnections(); // Chrome can leave an unused preconnect socket open.
    await stopped;
  }
}
