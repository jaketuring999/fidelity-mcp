import type { FidelityPagePolicy } from '../domain/fidelity-page.js';
import type {
  AccountInfo,
  AccountsSnapshot,
  AccountBalance,
  FailureCode,
  ReadOptions,
} from './protocol.js';

type JsonObject = Record<string, any>;
export type ReadOperation =
  | 'list_accounts'
  | 'read_balance'
  | 'read_positions'
  | 'read_tax_lots'
  | 'read_performance'
  | 'read_balance_history';

// This entire function is serialized into Chrome's MAIN world. Keep runtime
// dependencies inside it; imported contracts above are erased by TypeScript.
export async function fetchFidelityPortfolio(
  operation: ReadOperation,
  accountId: string | null | undefined,
  salt: string,
  pagePolicy: FidelityPagePolicy,
  options: ReadOptions = {},
): Promise<any> {
  const fail = (code: FailureCode) => ({ ok: false as const, code });
  if (location.origin !== pagePolicy.origin || location.pathname !== pagePolicy.portfolioPath)
    return fail('AUTHENTICATION_REQUIRED');
  if (
    !/^[a-f0-9]{64}$/.test(salt) ||
    ![
      'list_accounts',
      'read_balance',
      'read_positions',
      'read_tax_lots',
      'read_performance',
      'read_balance_history',
    ].includes(operation)
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
    if (
      !options ||
      typeof options !== 'object' ||
      Object.keys(options).some(
        (key) =>
          !(
            operation === 'read_tax_lots'
              ? ['symbol']
              : operation === 'read_balance_history'
                ? ['range']
                : []
          ).includes(key),
      ) ||
      (operation === 'read_tax_lots' &&
        (!accountId ||
          typeof options.symbol !== 'string' ||
          !options.symbol.trim() ||
          options.symbol.length > 100 ||
          !/^[A-Za-z0-9 ./*^_$+-]+$/.test(options.symbol))) ||
      (operation === 'read_balance_history' &&
        !['1M', 'YTD', '1Y', '3Y'].includes(options.range ?? ''))
    )
      return fail('API_CONTEXT_UNAVAILABLE');
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
    const changed = (): never => {
      throw new Error('PORTFOLIO_RESPONSE_CHANGED');
    };
    const optionalDecimal = (value: unknown, formatted = false): string | undefined => {
      if (
        value === undefined ||
        value === null ||
        value === '--' ||
        value === 'n/a' ||
        value === ''
      )
        return undefined;
      if (typeof value !== 'string' && typeof value !== 'number') return changed();
      let text = String(value);
      // Expand provider numeric exponents without rounding through toFixed.
      if (typeof value === 'number' && /e/i.test(text)) {
        const match = text.match(/^(-?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/i);
        if (!match) return changed();
        const digits = match[2]! + (match[3] ?? '');
        const point = match[2]!.length + Number(match[4]);
        if (Math.abs(point) > 30) return changed();
        text =
          match[1] +
          (point <= 0
            ? '0.' + '0'.repeat(-point) + digits
            : point >= digits.length
              ? digits + '0'.repeat(point - digits.length)
              : digits.slice(0, point) + '.' + digits.slice(point));
      }
      if (formatted) {
        text = text.trim();
        if (text.startsWith('(') && text.endsWith(')')) text = '-' + text.slice(1, -1);
        text = text
          .replace(/^([+-]?)\$/, '$1')
          .replace(/^\+/, '')
          .replace(/%$/, '');
        if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,10})?$/.test(text)) return changed();
        text = text.replace(/,/g, '');
      }
      return decimal(text, 10) ?? changed();
    };
    const calendarDate = (value: unknown): string => {
      if (typeof value !== 'string') return changed();
      let year: string, month: string, day: string;
      const us = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      const named = value.match(
        /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2})-(\d{4})$/,
      );
      if (us) [month, day, year] = [us[1]!, us[2]!, us[3]!];
      else if (iso) [year, month, day] = [iso[1]!, iso[2]!, iso[3]!];
      else if (named) {
        year = named[3]!;
        day = named[2]!;
        month = String(
          [
            'Jan',
            'Feb',
            'Mar',
            'Apr',
            'May',
            'Jun',
            'Jul',
            'Aug',
            'Sep',
            'Oct',
            'Nov',
            'Dec',
          ].indexOf(named[1]!) + 1,
        ).padStart(2, '0');
      } else return changed();
      const result = `${year}-${month}-${day}`;
      const date = new Date(result + 'T00:00:00Z');
      if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== result)
        return changed();
      return result;
    };
    const optionalDate = (value: unknown) =>
      value === undefined || value === null || value === '' || value === '--'
        ? undefined
        : calendarDate(value);
    const readJson = async (
      endpoint: string,
      body: unknown,
      headers: Record<string, string> = {},
    ) => {
      const response = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        redirect: 'error',
        cache: 'no-store',
        signal,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
      if (response.status === 401 || response.status === 403)
        throw new Error('READ_AUTHENTICATION_REQUIRED');
      if (!response.ok) throw new Error('READ_UNAVAILABLE');
      if (!response.headers.get('content-type')?.includes('json')) return changed();
      try {
        return await response.json();
      } catch {
        return changed();
      }
    };
    if (operation === 'read_performance') {
      const periods = ['1M', 'YTD', '1Y', '3Y'];
      const data = await readJson(
        'https://digital.fidelity.com/ftgw/digital/portfolio/api/GetAcctPerf',
        {
          entityDetails: assets.map((a) => ({
            entityId: a.acctNum,
            entityType: 'account',
            sourceSystemId: 'ICS',
          })),
          isAggregate: false,
          includePartialInMonthlyFreq: false,
          performanceDetails: [
            {
              calculationTypes: ['TW'],
              taxTypes: ['pretax'],
              perfDetailType: 'cumulative',
              returnTypes: ['NET'],
              returnFrequency: ['D'],
              historicalReturnsFrequency: [],
              standardTimePeriods: periods,
            },
          ],
        },
      );
      if (
        data?.errors?.length ||
        !Array.isArray(data?.perfDetails) ||
        data.perfDetails.length !== assets.length
      )
        return fail('API_RESPONSE_CHANGED');
      const seen = new Set<string>();
      const accounts = data.perfDetails.map((item: JsonObject) => {
        const index = assets.findIndex((a) => a.acctNum === item?.entityId);
        if (index < 0 || seen.has(item.entityId) || item.entityType !== 'account') return changed();
        seen.add(item.entityId);
        if (!Array.isArray(item.cumulativePerfReturns) || item.cumulativePerfReturns.length > 1)
          return changed();
        const series = item.cumulativePerfReturns[0];
        if (
          series &&
          (series.calculationType !== 'TW' ||
            series.taxType !== 'pretax' ||
            series.returnFrequency !== 'D' ||
            !Array.isArray(series.returns) ||
            series.returns.length > periods.length)
        )
          return changed();
        const returned = new Set<string>();
        const returns = (series?.returns ?? []).map((r: JsonObject) => {
          if (!r || !periods.includes(r.period) || returned.has(r.period)) return changed();
          returned.add(r.period);
          const startDate = calendarDate(r.startDate),
            endDate = calendarDate(r.endDate);
          if (startDate > endDate) return changed();
          return {
            period: r.period,
            startDate,
            endDate,
            netReturnPercent: optionalDecimal(r.netReturn),
            benchmarkReturnPercent: optionalDecimal(r.benchmarkReturn),
          };
        });
        return {
          ...selectedInfos[index],
          asOfDate: optionalDate(item.asOfDate),
          dailyAsOfDate: optionalDate(item.dailyAsOfDate),
          inceptionDate: optionalDate(series?.perfInceptionDate),
          calculationType: 'TW',
          taxType: 'pretax',
          returnFrequency: 'D',
          returns,
          unavailablePeriods: periods.filter(
            (period) =>
              !returns.some(
                (r: JsonObject) => r.period === period && r.netReturnPercent !== undefined,
              ),
          ),
        };
      });
      return { ok: true, retrievedAt: new Date().toISOString(), accounts };
    }
    if (operation === 'read_balance_history') {
      const accounts = [];
      // The provider returns an aggregate with no account echo. Read each account
      // separately so one unavailable account cannot silently disappear in a total.
      for (let index = 0; index < assets.length; index++) {
        const a = assets[index]!;
        const data = await readJson(
          'https://digital.fidelity.com/ftgw/digital/portfolio/api/BalanceHistory',
          {
            range: options.range,
            acctList: [{ acctNum: a.acctNum, acctType: a.acctType, acctSubType: a.acctSubType }],
          },
        );
        if (
          data?.errors?.length ||
          (data?.sysMsg !== null &&
            data?.sysMsg !== undefined &&
            (!Array.isArray(data.sysMsg) || data.sysMsg.length))
        )
          return fail('PORTFOLIO_UNAVAILABLE');
        const detail = data?.balHistoryDetail;
        if (
          !Array.isArray(detail?.balances) ||
          !detail.balances.length ||
          detail.balances.length > 2000
        )
          return fail('API_RESPONSE_CHANGED');
        const dates = new Set<string>();
        const balances = detail.balances
          .map((point: JsonObject) => {
            const date = calendarDate(point?.date),
              value = optionalDecimal(point?.value);
            if (dates.has(date) || value === undefined) return changed();
            dates.add(date);
            return { date, value };
          })
          .sort((a: JsonObject, b: JsonObject) => a.date.localeCompare(b.date));
        accounts.push({
          ...selectedInfos[index],
          balances,
          requestedDateRangeGainLoss: optionalDecimal(detail.requestedDateRangeGainLoss),
          requestedDateRangeGainLossPercent: optionalDecimal(detail.requestedDateRangeGainLossPct),
        });
      }
      return { ok: true, retrievedAt: new Date().toISOString(), range: options.range, accounts };
    }
    if (operation === 'read_positions' || operation === 'read_tax_lots') {
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
          // Fidelity uses display placeholders when an optional measure is unavailable.
          if (value === undefined || value === null || value === '--' || value === 'n/a')
            return undefined;
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
      if (operation === 'read_tax_lots') {
        const rows = data.rowData.filter(
          (row: JsonObject) =>
            ['POSITION', 'POSITION_CORE'].includes(row.rowType) &&
            row.sym?.name?.toUpperCase() === options.symbol!.trim().toUpperCase(),
        );
        if (!rows.length) return fail('POSITION_NOT_FOUND');
        if (rows.length > 100) return fail('API_RESPONSE_CHANGED');
        const positions = [];
        for (const row of rows) {
          const holdingType =
            row.meta?.holdingType === 'Margin'
              ? 'margin'
              : row.meta?.holdingType === 'Cash' || row.rowType === 'POSITION_CORE'
                ? 'cash'
                : 'unknown';
          if (row.meta?.isEligibleForLots !== true) {
            positions.push({ symbol: row.sym.name, holdingType, status: 'not_eligible', lots: [] });
            continue;
          }
          const lots: JsonObject[] = [];
          const seenLots = new Set<number>();
          let pageNum = 1,
            totalLots: number | undefined,
            lastPage: number | undefined;
          for (;;) {
            const result = await readJson(
              'https://digital.fidelity.com/ftgw/digital/positions/poswebex/api/openlots-json',
              {
                acctNum: row.actNum,
                acctType: 'Brokerage',
                cusip: row.sym.cusip ?? '',
                symbol: row.sym.name,
                holdingType: row.meta.holdingType,
                isUnadjusted: false,
                isCostBasisAdjusted: ['Bond', 'Certificate Of Deposit'].includes(
                  row.meta.securityType,
                ),
                pageNum,
                pageSize: 250,
                returnBasketTaxLotDetail: false,
                slvCd: row.meta.slvCd,
                positionDetail: {
                  lastPrice: row.lstPrcUsd?.val ?? row.lstPrc?.val ?? row.lstPrStk?.top?.val ?? '',
                  securityType: row.meta.securityType ?? '',
                  currentValue: row.curVal.val,
                  quantity: row.qty?.val ?? '',
                  costBasis: row.meta.cstbasType ?? '',
                  isCostBasisEditable: row.meta.isCostBasisEditable ?? false,
                  isNotQuotable: row.meta.isNotQuotable ?? false,
                  isCrypto: false,
                },
              },
              {
                'X-CSRF-Token': config.ctoken,
                'Preset-View': 'StackOverView',
                whereUsed: location.href,
                virtualmode: config.virtualmode ?? 'N',
                virtualpwe: config.virtualpwe ?? 'multiple',
              },
            );
            const pagination = result?.pagination;
            if (
              !Array.isArray(result?.rows) ||
              result.rows.length > 250 ||
              !pagination ||
              !Number.isSafeInteger(pagination.totalLots) ||
              pagination.totalLots < 0 ||
              pagination.totalLots > 10000 ||
              pagination.currentPage !== pageNum ||
              !Number.isSafeInteger(pagination.lastPage) ||
              pagination.lastPage < 1 ||
              pagination.lastPage > 40 ||
              !Number.isSafeInteger(pagination.nextPage) ||
              (totalLots !== undefined &&
                (pagination.totalLots !== totalLots || pagination.lastPage !== lastPage))
            )
              return fail('API_RESPONSE_CHANGED');
            totalLots = pagination.totalLots;
            lastPage = pagination.lastPage;
            for (const lot of result.rows) {
              if (
                !lot ||
                !Number.isSafeInteger(lot.index) ||
                lot.index < 0 ||
                seenLots.has(lot.index) ||
                typeof lot.isWashedSale !== 'boolean' ||
                typeof lot.isNearingLongTerm !== 'boolean'
              )
                return fail('API_RESPONSE_CHANGED');
              seenLots.add(lot.index);
              const dateAcquired =
                lot.dateAcquired === 'Various' ? undefined : optionalDate(lot.dateAcquired);
              if (!['Short', 'Long', '--', 'Unknown', '', null, undefined].includes(lot.term))
                return fail('API_RESPONSE_CHANGED');
              lots.push({
                lotNumber: lot.index,
                dateAcquired,
                acquisitionDateStatus: dateAcquired
                  ? 'known'
                  : lot.dateAcquired === 'Various'
                    ? 'various'
                    : 'unavailable',
                holdingPeriodDate: optionalDate(lot.holdingPeriodDate),
                term: lot.term === 'Short' ? 'short' : lot.term === 'Long' ? 'long' : 'unknown',
                quantity: optionalDecimal(lot.quantity, true),
                currentValue: optionalDecimal(lot.currentValue, true),
                averageCostBasis: optionalDecimal(lot.averageCostBasis, true),
                costBasisTotal: optionalDecimal(lot.costBasisTotal, true),
                totalGainLoss: optionalDecimal(lot.totalGainLoss, true),
                totalGainLossPercent: optionalDecimal(lot.totalGainLossPct, true),
                isWashSale: lot.isWashedSale,
                isNearingLongTerm: lot.isNearingLongTerm,
              });
            }
            if (pageNum === lastPage) {
              if (lots.length !== totalLots) return fail('API_RESPONSE_CHANGED');
              break;
            }
            if (!result.rows.length || pagination.nextPage !== pageNum + 1)
              return fail('API_RESPONSE_CHANGED');
            pageNum++;
          }
          positions.push({ symbol: row.sym.name, holdingType, status: 'available', lots });
        }
        return {
          ok: true,
          retrievedAt: new Date().toISOString(),
          accounts: [{ ...selectedInfos[0], positions }],
        };
      }
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
    if (
      error instanceof Error &&
      ['POSITION_RESPONSE_CHANGED', 'PORTFOLIO_RESPONSE_CHANGED'].includes(error.message)
    )
      return fail('API_RESPONSE_CHANGED');
    if (error instanceof Error && error.message === 'READ_AUTHENTICATION_REQUIRED')
      return fail('AUTHENTICATION_REQUIRED');
    return fail('PORTFOLIO_UNAVAILABLE'); // Never leak provider exceptions, headers or account context.
  }
}
