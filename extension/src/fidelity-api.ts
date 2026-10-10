import type {
  AccountInfo,
  AccountsSnapshot,
  AccountBalance,
  FailureCode,
} from '../../src/bridge/protocol.js';

type JsonObject = Record<string, any>;
export type ReadOperation = 'list_accounts' | 'read_balance' | 'read_positions';

// This entire function is serialized into Chrome's MAIN world. Keep runtime
// dependencies inside it; imported contracts above are erased by TypeScript.
export async function fetchFidelityPortfolio(
  operation: ReadOperation,
  accountId: string | null | undefined,
  salt: string,
): Promise<any> {
  const fail = (code: FailureCode) => ({ ok: false as const, code });
  if (
    location.origin !== 'https://digital.fidelity.com' ||
    !location.pathname.startsWith('/ftgw/digital/portfolio/')
  )
    return fail('AUTHENTICATION_REQUIRED');
  if (
    !/^[a-f0-9]{64}$/.test(salt) ||
    !['list_accounts', 'read_balance', 'read_positions'].includes(operation)
  )
    return fail('API_CONTEXT_UNAVAILABLE');
  const page = window as unknown as JsonObject;
  const context = page.PortSumContainer;
  if (!context?.PicoService?.getPersonContext) return fail('API_CONTEXT_UNAVAILABLE');
  try {
    const signal = AbortSignal.timeout(15_000);
    const person = await context.PicoService.getPersonContext();
    if (!Array.isArray(person?.person?.assets)) return fail('API_CONTEXT_UNAVAILABLE');
    // "All" is independent of the currently highlighted account in the UI.
    const allAssets: JsonObject[] = person.person.assets.filter(
      (a: JsonObject) => !a.preferenceDetail?.isHidden && a.acctType === 'Brokerage',
    );
    if (
      allAssets.length > 100 ||
      allAssets.some(
        (a) => typeof a.acctNum !== 'string' || !/^[A-Za-z0-9]{4,30}$/.test(a.acctNum),
      ) ||
      new Set(allAssets.map((a) => a.acctNum)).size !== allAssets.length
    )
      return fail('API_CONTEXT_UNAVAILABLE');
    const infos: AccountInfo[] = await Promise.all(
      allAssets.map(async (a) => {
        const digest = await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(`${salt}:${a.acctNum}`),
        );
        return {
          accountId: `acct_${Array.from(new Uint8Array(digest))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('')
            .slice(0, 32)}`,
          last4: a.acctNum.slice(-4),
          name: String(a.preferenceDetail?.name ?? 'Brokerage'),
          accountType: 'Brokerage',
        };
      }),
    );
    if (operation === 'list_accounts')
      return {
        ok: true,
        source: 'fidelity_browser_context',
        scope: 'all_visible_brokerage_accounts',
        retrievedAt: new Date().toISOString(),
        accounts: infos,
      } satisfies AccountsSnapshot & { ok: true };
    const indexes = infos
      .map((info, index) => ({ info, index }))
      .filter(({ info }) => !accountId || info.accountId === accountId);
    if (!indexes.length) return fail(accountId ? 'ACCOUNT_NOT_FOUND' : 'PORTFOLIO_UNAVAILABLE');
    const assets = indexes.map(({ index }) => allAssets[index]!);
    const selectedInfos = indexes.map(({ info }) => info);
    const compress = async (value: unknown) => {
      const bytes = new TextEncoder().encode(JSON.stringify(value));
      const compressed = await new Response(
        new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip')),
      ).arrayBuffer();
      let binary = '';
      for (const byte of new Uint8Array(compressed)) binary += String.fromCharCode(byte);
      return btoa(binary);
    };
    const decimal = (value: unknown, places: number): string | undefined => {
      if (typeof value !== 'string' && typeof value !== 'number') return undefined;
      const text = String(value);
      if (!new RegExp(`^-?\\d{1,15}(?:\\.\\d{1,${places}})?$`).test(text)) return undefined;
      return text;
    };
    const money = (value: unknown): string | undefined => {
      const text = decimal(value, 2);
      if (text === undefined) return undefined;
      const [whole, fraction = ''] = text.split('.');
      return `${whole}.${fraction.padEnd(2, '0')}`;
    };
    if (operation === 'read_positions') {
      const endpoint = 'https://digital.fidelity.com/ftgw/digital/positions/poswebex/api/positions';
      let config = page.posweb;
      if (typeof config?.ctoken !== 'string' || typeof config?.user !== 'string') {
        const bootstrap = await fetch(
          'https://digital.fidelity.com/ftgw/digital/positions/poswebex/?snippet=Y',
          { credentials: 'include', redirect: 'error', signal },
        );
        if (bootstrap.status === 401 || bootstrap.status === 403)
          return fail('AUTHENTICATION_REQUIRED');
        if (!bootstrap.ok) return fail('PORTFOLIO_UNAVAILABLE');
        const text = await bootstrap.text();
        const field = (key: string) =>
          text.match(new RegExp(`["']?${key}["']?\\s*:\\s*["']([^"']*)["']`))?.[1];
        const ctoken = field('ctoken'),
          user = field('user');
        if (ctoken === undefined || user === undefined) return fail('API_CONTEXT_UNAVAILABLE');
        config = {
          ctoken,
          user,
          virtualmode: field('virtualmode') ?? 'N',
          virtualpwe: field('virtualpwe') ?? 'multiple',
        };
      }
      const pico = await compress({
        accounts: assets.map((a) => ({
          accountId: a.acctNum,
          acctType: a.acctType,
          acctSubType: a.acctSubType,
          brokerageAccount: true,
        })),
        hasSPS: false,
        pznFPLAccts: [],
      });
      const response = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        redirect: 'error',
        cache: 'no-store',
        signal,
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': config.ctoken,
          'Preset-View': 'StackOverView',
          whereUsed: location.href,
          virtualmode: config.virtualmode ?? 'N',
          virtualpwe: config.virtualpwe ?? 'multiple',
        },
        body: JSON.stringify({
          accts: assets.map((a) => a.acctNum),
          pico,
          pzn: [],
          allTreatments: [],
          externalCustId: config.user,
          isBasketEnable: false,
          isGroupBySecurityEnable: false,
          isRefresh: true,
          settings: { groupBy: '0', filter: '' },
          toggles: {},
        }),
      });
      if (response.status === 401 || response.status === 403)
        return fail('AUTHENTICATION_REQUIRED');
      if (!response.ok) return fail('PORTFOLIO_UNAVAILABLE');
      if (!response.headers.get('content-type')?.includes('json'))
        return fail('API_RESPONSE_CHANGED');
      const data = await response.json();
      if (
        !Array.isArray(data?.rowData) ||
        data.totalNoOfAccts !== assets.length ||
        !Array.isArray(data.acctTot) ||
        data.acctTot.length !== assets.length
      )
        return fail('API_RESPONSE_CHANGED');
      const expectedIds = new Set(assets.map((a) => a.acctNum));
      const totalIds = data.acctTot.map((a: JsonObject) => a?.acctNum);
      if (
        new Set(totalIds).size !== assets.length ||
        totalIds.some((id: unknown) => !expectedIds.has(id))
      )
        return fail('API_RESPONSE_CHANGED');
      const accounts = selectedInfos.map((info) => ({ ...info, positions: [] as JsonObject[] }));
      const headers = new Set<string>();
      let rowCount = 0;
      for (const row of data.rowData) {
        if (++rowCount > 20_000 || !row || typeof row.rowType !== 'string')
          return fail('API_RESPONSE_CHANGED');
        if (['SPACER', 'GRAND_TOTAL'].includes(row.rowType)) continue;
        const index = assets.findIndex((a) => a.acctNum === row.actNum);
        if (index < 0) return fail('API_RESPONSE_CHANGED');
        if (row.rowType === 'ACCOUNT') {
          if (headers.has(row.actNum)) return fail('API_RESPONSE_CHANGED');
          headers.add(row.actNum);
          continue;
        }
        if (['PENDING', 'ACCOUNT_TOTAL'].includes(row.rowType)) continue;
        if (!['POSITION', 'POSITION_CORE'].includes(row.rowType))
          return fail('API_RESPONSE_CHANGED');
        const symbol = row.sym?.name,
          currentValue = decimal(row.curVal?.val, 10);
        if (typeof symbol !== 'string' || !symbol || currentValue === undefined)
          return fail('API_RESPONSE_CHANGED');
        const optional = (value: unknown): string | undefined => {
          if (value === undefined || value === null) return undefined;
          const text = decimal(value, 10);
          if (text === undefined) throw new Error('POSITION_RESPONSE_CHANGED');
          return text;
        };
        accounts[index]!.positions.push({
          symbol,
          description: String(row.sym.desc ?? symbol),
          currentValue,
          quantity: optional(row.qty?.val),
          lastPrice: optional(row.lstPrStk?.top?.val),
          costBasis: optional(row.cstBasStk?.top?.val),
          todayGainLoss: optional(row.todGLStk?.top?.val),
          totalGainLoss: optional(row.totGLStk?.top?.val),
          holdingType:
            row.meta?.holdingType === 'Margin'
              ? 'margin'
              : row.meta?.holdingType === 'Cash' || row.rowType === 'POSITION_CORE'
                ? 'cash'
                : 'unknown',
        });
      }
      if (headers.size !== assets.length) return fail('API_RESPONSE_CHANGED');
      return { ok: true, retrievedAt: new Date().toISOString(), accounts };
    }
    const endpoint = 'https://digital.fidelity.com/ftgw/digital/balwebex/api/balances';
    let config = page.balExpConfig;
    if (typeof config?.ctoken !== 'string') {
      const bootstrap = await fetch('https://digital.fidelity.com/ftgw/digital/balwebex/', {
        credentials: 'include',
        redirect: 'error',
        signal,
      });
      if (bootstrap.status === 401 || bootstrap.status === 403)
        return fail('AUTHENTICATION_REQUIRED');
      if (!bootstrap.ok) return fail('BALANCE_UNAVAILABLE');
      const text = await bootstrap.text();
      const tokenMatch = text.match(/["']?ctoken["']?\s*:\s*["']([^"']*)["']/);
      if (!tokenMatch) return fail('API_CONTEXT_UNAVAILABLE');
      config = { ctoken: tokenMatch[1], virtualmode: 'N', virtualbwe: 'multiple' };
    }
    const request = assets.map((a) => ({
      account: { acctNum: a.acctNum, acctType: a.acctType, acctSubType: a.acctSubType },
      acctTradeAttrDetail: a.acctTradeAttrDetail,
      acctLegalAttrDetail: a.acctLegalAttrDetail,
      acctPreferenceDetail: { name: a.preferenceDetail?.name },
      acctMrgnOptionSpreadsDetail: {
        hasMargin: Boolean(
          a.acctFeature?.featureDetails?.established?.marginOptionSpreadsDetail?.hasMargin,
        ),
        hasMarginDebtProtection: Boolean(
          a.acctFeature?.featureDetails?.established?.marginOptionSpreadsDetail
            ?.hasMarginDebtProtection,
        ),
      },
    }));
    const response = await fetch(endpoint, {
      method: 'POST',
      credentials: 'include',
      redirect: 'error',
      cache: 'no-store',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': config.ctoken,
        whereUsed: location.href,
        virtualmode: config.virtualmode ?? 'N',
        virtualbwe: config.virtualbwe ?? 'multiple',
      },
      body: JSON.stringify({ picoString: await compress(request) }),
    });
    if (response.status === 401 || response.status === 403) return fail('AUTHENTICATION_REQUIRED');
    if (!response.ok) return fail('BALANCE_UNAVAILABLE');
    if (!response.headers.get('content-type')?.includes('json'))
      return fail('AUTHENTICATION_REQUIRED');
    const data = await response.json();
    if (!Array.isArray(data) || data.length !== assets.length) return fail('API_RESPONSE_CHANGED');
    const seen = new Set<string>();
    const accounts: AccountBalance[] = [];
    for (const item of data) {
      const id = item?.account?.acctNum;
      const index = assets.findIndex((a) => a.acctNum === id);
      if (index < 0 || seen.has(id)) return fail('API_RESPONSE_CHANGED');
      seen.add(id);
      const totalAccountValue = money(item.balance?.totalAcctVal);
      if (totalAccountValue === undefined) return fail('API_RESPONSE_CHANGED');
      const detail = item.balance?.brokBalDetail;
      const info = selectedInfos[index]!;
      accounts.push({
        accountId: info.accountId,
        last4: info.last4,
        name: info.name,
        totalAccountValue,
        cashAvailableToTrade: money(detail?.availToTradeDetail?.cashAvailForTrade),
        settledCash: detail?.cashDetail?.canShowCashSettled
          ? money(detail.cashDetail.cashSettled)
          : undefined,
        cashAvailableToWithdraw: money(detail?.availToWithdrawDetail?.cashOnlyAvailToWithdraw),
      });
    }
    return { ok: true, retrievedAt: new Date().toISOString(), accounts };
  } catch (error) {
    if (error instanceof Error && error.message === 'POSITION_RESPONSE_CHANGED')
      return fail('API_RESPONSE_CHANGED');
    return fail('PORTFOLIO_UNAVAILABLE'); // Never leak provider exceptions, headers or account context.
  }
}
