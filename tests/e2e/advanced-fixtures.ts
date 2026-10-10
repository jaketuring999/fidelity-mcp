import assert from 'node:assert/strict';

// Synthetic contracts based on live schema validation; never customer captures.
export function advancedFixture(url: string, body: any, mode: string) {
  const periods = ['1M', 'YTD', '1Y', '3Y'];
  if (url.endsWith('/GetAcctPerf')) {
    assert.deepEqual(body.performanceDetails, [
      {
        calculationTypes: ['TW'],
        taxTypes: ['pretax'],
        perfDetailType: 'cumulative',
        returnTypes: ['NET'],
        returnFrequency: ['D'],
        historicalReturnsFrequency: [],
        standardTimePeriods: periods,
      },
    ]);
    assert.equal(body.isAggregate, false);
    assert.equal(body.includePartialInMonthlyFreq, false);
    for (const entity of body.entityDetails) {
      assert.ok(['TEST1234', 'NEXT1234'].includes(entity.entityId));
      assert.equal(entity.entityType, 'account');
      assert.equal(entity.sourceSystemId, 'ICS');
    }
    const payload = {
      perfDetails: body.entityDetails
        .map((e: any) => ({
          entityId: e.entityId,
          entityType: 'account',
          asOfDate: '10/09/2026',
          dailyAsOfDate: '10/09/2026',
          annualPerfReturns: null,
          cumulativePerfReturns: [
            {
              calculationType: mode === 'wrong-calculation' ? 'MW' : 'TW',
              taxType: 'pretax',
              returnFrequency: 'D',
              perfInceptionDate: '01/01/2026',
              returns: [
                {
                  period: '1M',
                  startDate: '09/09/2026',
                  endDate: '10/09/2026',
                  netReturn: mode === 'malformed-performance' ? 'NaN' : -2.125,
                  benchmarkReturn: null,
                },
                {
                  period: 'YTD',
                  startDate: '01/01/2026',
                  endDate: '10/09/2026',
                  netReturn: 0,
                  benchmarkReturn: 1.5,
                },
              ],
            },
          ],
        }))
        .reverse(),
    };
    if (mode === 'missing-performance-account') payload.perfDetails.pop();
    if (mode === 'duplicate-performance-account') payload.perfDetails.push(payload.perfDetails[0]);
    if (mode === 'wrong-performance-account') payload.perfDetails[0].entityId = 'EVIL1234';
    if (mode === 'duplicate-performance-period')
      payload.perfDetails[0].cumulativePerfReturns[0].returns.push(
        payload.perfDetails[0].cumulativePerfReturns[0].returns[0],
      );
    if (mode === 'empty-performance')
      payload.perfDetails.forEach((a: any) => (a.cumulativePerfReturns = []));
    return payload;
  }
  if (url.endsWith('/BalanceHistory')) {
    assert.ok(periods.includes(body.range));
    assert.equal(
      body.acctList.length,
      1,
      'Each history read scopes the unkeyed response to one account.',
    );
    assert.ok(['TEST1234', 'NEXT1234'].includes(body.acctList[0].acctNum));
    assert.equal(body.acctList[0].acctType, 'Brokerage');
    const balances = [
      { date: '10/09/2026', value: 0.2 },
      {
        date: mode === 'bad-history-date' ? '02/30/2026' : '10/08/2026',
        value: mode === 'malformed-history' ? 'oops' : -0.1,
      },
    ];
    if (mode === 'duplicate-history-date') balances[1].date = balances[0].date;
    if (mode === 'empty-history') balances.length = 0;
    return {
      sysMsg:
        mode === 'partial-history'
          ? [
              {
                type: 'ERROR',
                code: '4002',
                source: 'DP',
                message: 'private provider text TEST1234',
              },
            ]
          : null,
      balHistoryDetail: {
        requestedDateRangeGainLoss: 0.3,
        requestedDateRangeGainLossPct: null,
        balances,
      },
    };
  }
  if (url.endsWith('/openlots-json')) {
    assert.equal(body.acctNum, 'TEST1234');
    assert.equal(body.symbol, 'TEST');
    assert.equal(body.holdingType, 'Margin');
    assert.equal(body.isUnadjusted, false);
    assert.equal(body.pageSize, 250);
    assert.equal(body.acctType, 'Brokerage');
    const lot = (index: number) => ({
      index,
      dateAcquired: index ? 'Various' : 'Sep-09-2026',
      holdingPeriodDate: index ? '--' : 'Sep-08-2026',
      term: index ? 'Long' : 'Short',
      quantity: index ? 1e-8 : 1.12345678,
      totalGainLoss: mode === 'malformed-lot' ? '$oops' : '($1,234.56)',
      totalGainLossPct: '+1.25%',
      currentValue: '$2,345.67',
      averageCostBasis: '--',
      costBasisTotal: 'n/a',
      isWashedSale: true,
      isNearingLongTerm: false,
      positionType: 'Long',
    });
    // Force 251 lots over two pages to exercise completeness rather than just page one.
    const rows = Array.from(
      { length: mode === 'oversized-lots' || body.pageNum === 1 ? 250 : 1 },
      (_, i) =>
        lot(
          mode === 'oversized-lots' ? (body.pageNum - 1) * 250 + i : body.pageNum === 1 ? i : 250,
        ),
    );
    if (mode === 'duplicate-lot-page' && body.pageNum === 2) rows[0].index = 0;
    return {
      pagination: {
        currentPage: body.pageNum,
        prevPage: body.pageNum - 1,
        nextPage:
          mode === 'looping-lot-page'
            ? body.pageNum
            : mode === 'oversized-lots'
              ? body.pageNum + 1
              : body.pageNum === 1
                ? 2
                : 0,
        lastPage: mode === 'oversized-lots' ? 8 : 2,
        pageSize: 250,
        totalLots: mode === 'oversized-lots' ? 2000 : mode === 'incomplete-lots' ? 252 : 251,
      },
      columns: [],
      rows,
      metadata: { hasWashSales: true, isUnadjusted: false },
    };
  }
  return undefined;
}

export async function verifyAdvancedTools(
  tool: (name: string, args?: Record<string, unknown>) => Promise<any>,
  accountId: string,
  setMode: (mode: string) => void,
) {
  setMode('normal');
  for (const args of [{}, { accountId }]) {
    const perf = (await tool('fidelity_get_performance', args)).structuredContent;
    assert.ok(perf);
    assert.equal(perf.accounts.length, 'accountId' in args ? 1 : 2);
    if ('accountId' in args) assert.equal(perf.accounts[0].accountId, accountId);
    for (const a of perf.accounts) {
      assert.equal(a.asOfDate, '2026-10-09');
      assert.equal(a.calculationType, 'TW');
      assert.equal(a.returns[0].netReturnPercent, '-2.125');
      assert.equal(a.returns[0].benchmarkReturnPercent, undefined);
      assert.equal(a.returns[1].netReturnPercent, '0');
      assert.equal(a.returns[1].benchmarkReturnPercent, '1.5');
      assert.deepEqual(a.unavailablePeriods, ['1Y', '3Y']);
    }
    for (const range of ['1M', 'YTD', '1Y', '3Y']) {
      const history = (await tool('fidelity_get_balance_history', { ...args, range }))
        .structuredContent;
      assert.equal(history.range, range);
      assert.equal(history.accounts.length, 'accountId' in args ? 1 : 2);
      assert.deepEqual(history.accounts[0].balances, [
        { date: '2026-10-08', value: '-0.1' },
        { date: '2026-10-09', value: '0.2' },
      ]);
      assert.equal(history.accounts[0].requestedDateRangeGainLossPercent, undefined);
    }
  }
  assert.equal(
    (await tool('fidelity_get_balance_history', { accountId })).structuredContent.range,
    '1Y',
  );
  const tax = (await tool('fidelity_get_tax_lots', { accountId, symbol: 'test' }))
    .structuredContent;
  assert.equal(tax.accounts[0].positions[0].lots.length, 251);
  const lot = tax.accounts[0].positions[0].lots[0];
  assert.equal(lot.dateAcquired, '2026-09-09');
  assert.equal(lot.holdingPeriodDate, '2026-09-08');
  assert.equal(lot.totalGainLoss, '-1234.56');
  assert.equal(lot.totalGainLossPercent, '1.25');
  assert.equal(lot.currentValue, '2345.67');
  assert.equal(lot.quantity, '1.12345678');
  assert.equal(lot.costBasisTotal, undefined);
  assert.equal(lot.isWashSale, true);
  assert.equal(tax.accounts[0].positions[0].lots[1].quantity, '0.00000001');
  assert.equal(tax.accounts[0].positions[0].lots[1].dateAcquired, undefined);
  assert.equal(tax.accounts[0].positions[0].lots[1].acquisitionDateStatus, 'various');
  setMode('ineligible-lots');
  const ineligible = (await tool('fidelity_get_tax_lots', { accountId, symbol: 'TEST' }))
    .structuredContent;
  assert.equal(ineligible.accounts[0].positions[0].status, 'not_eligible');
  assert.deepEqual(ineligible.accounts[0].positions[0].lots, []);
  setMode('normal');
  assert.match(
    JSON.stringify(await tool('fidelity_get_tax_lots', { accountId, symbol: 'ABSENT' })),
    /POSITION_NOT_FOUND/,
  );
  assert.ok((await tool('fidelity_get_tax_lots', { symbol: 'TEST' })).error);
  assert.ok((await tool('fidelity_get_balance_history', { range: 'MAX' })).error);
  assert.ok((await tool('fidelity_get_performance', { url: 'https://evil.test' })).error);
  for (const [name, args, modes] of [
    [
      'fidelity_get_tax_lots',
      { accountId, symbol: 'TEST' },
      ['malformed-lot', 'incomplete-lots', 'duplicate-lot-page', 'looping-lot-page'],
    ],
    [
      'fidelity_get_performance',
      {},
      [
        'malformed-performance',
        'wrong-calculation',
        'missing-performance-account',
        'duplicate-performance-account',
        'wrong-performance-account',
        'duplicate-performance-period',
      ],
    ],
    [
      'fidelity_get_balance_history',
      {},
      [
        'malformed-history',
        'bad-history-date',
        'duplicate-history-date',
        'empty-history',
        'partial-history',
      ],
    ],
  ] as const) {
    for (const mode of [...modes, 'expired']) {
      setMode(mode);
      const result = await tool(name, args);
      assert.equal(result.isError, true, `${name}: ${mode}`);
      assert.equal(result.structuredContent, undefined);
      assert.doesNotMatch(JSON.stringify(result), /TEST1234|NEXT1234|private provider text/);
    }
  }
  setMode('oversized-lots');
  const oversized = await tool('fidelity_get_tax_lots', { accountId, symbol: 'TEST' });
  assert.equal(oversized.isError, true, 'Oversized response fails explicitly');
  assert.match(JSON.stringify(oversized), /RESPONSE_TOO_LARGE/);
  setMode('empty-performance');
  const empty = (await tool('fidelity_get_performance')).structuredContent;
  assert.deepEqual(empty.accounts[0].unavailablePeriods, ['1M', 'YTD', '1Y', '3Y']);
  setMode('normal');
  assert.doesNotMatch(JSON.stringify(tax), /TEST1234|NEXT1234|synthetic-csrf|synthetic-customer/);
}
