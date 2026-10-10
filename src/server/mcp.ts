import { FastMCP, ToolResult } from '@prefecthq/fastmcp-ts/server';
import { z } from 'zod';
import { FidelityError } from '../domain/errors.js';
import type { PortfolioReader } from '../bridge/portfolio-reader.js';
import { accountIdSchema, historyRangeSchema, symbolSchema } from '../bridge/protocol.js';

export function createServer(
  session: Pick<
    PortfolioReader,
    | 'listAccounts'
    | 'getBalance'
    | 'getPositions'
    | 'getTaxLots'
    | 'getPerformance'
    | 'getBalanceHistory'
  >,
): FastMCP {
  const server = new FastMCP({ name: 'fidelity-mcp', version: '0.2.0', logLevel: 'error' });
  const annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  };
  const selection = z
    .object({
      accountId: accountIdSchema
        .optional()
        .describe(
          'Opaque accountId from fidelity_list_accounts. Omit for all visible supported Fidelity brokerage accounts, regardless of the account highlighted in Chrome.',
        ),
    })
    .strict();
  const guarded = async (read: () => Promise<unknown>) => {
    try {
      return await read();
    } catch (error) {
      const known = error instanceof FidelityError;
      return new ToolResult({
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              code: known ? error.code : 'PORTFOLIO_UNAVAILABLE',
              message: known
                ? error.message
                : 'Portfolio read failed. Check the Fidelity browser and try again.',
            }),
          },
        ],
      });
    }
  };
  server.tool(
    {
      name: 'fidelity_list_accounts',
      title: 'List Fidelity accounts',
      description:
        'List all visible supported Fidelity brokerage accounts, including brokerage IRAs, through your Chrome session. Returns opaque accountIds for balance and positions calls, names and masked account numbers. External, hidden and other account types are excluded. Account references last for the Chrome browser session; list again after restarting Chrome.',
      input: z.object({}).strict(),
      annotations,
    },
    async () => guarded(() => session.listAccounts()),
  );
  server.tool(
    {
      name: 'fidelity_get_account_balance',
      title: 'Get Fidelity account balance',
      description:
        'Read account value and explicit cash availability. Omit accountId for all visible supported Fidelity brokerage accounts or provide an accountId from fidelity_list_accounts for one account. Returns USD decimal strings and exact combined account value. Cash available to trade, settled cash and cash-only withdrawal availability are distinct. Fidelity data may lag; sign in in Chrome if authentication expires.',
      input: selection,
      annotations,
    },
    async ({ accountId }) => guarded(() => session.getBalance(accountId)),
  );
  server.tool(
    {
      name: 'fidelity_get_positions',
      title: 'Get Fidelity positions',
      description:
        'Read holdings grouped by supported Fidelity brokerage account. Omit accountId for all visible supported accounts or provide an accountId from fidelity_list_accounts for one account. Returns quantities, current values, prices, cost basis and gains when supplied; separates cash and margin holdings and excludes account headers/totals. External accounts are excluded. Retrieval time is not quote time.',
      input: selection,
      annotations,
    },
    async ({ accountId }) => guarded(() => session.getPositions(accountId)),
  );
  server.tool(
    {
      name: 'fidelity_get_tax_lots',
      title: 'Get Fidelity open tax lots',
      description:
        'Read all open tax-lot pages for one held symbol in one supported brokerage account. Requires an opaque accountId from fidelity_list_accounts and a symbol from fidelity_get_positions. Keeps cash and margin holdings separate. Returns acquisition/holding-period dates, adjusted cost basis, gains and wash-sale flags when supplied; explicitly marks ineligible holdings. Percentages are percentage points, unavailable measures are omitted. No lot reassignment or trading.',
      input: z.object({ accountId: accountIdSchema, symbol: symbolSchema }).strict(),
      annotations,
    },
    async ({ accountId, symbol }) => guarded(() => session.getTaxLots(accountId, symbol)),
  );
  server.tool(
    {
      name: 'fidelity_get_performance',
      title: 'Get Fidelity account performance',
      description:
        'Read Fidelity cumulative time-weighted (TW), pretax, net returns for 1M, YTD, 1Y and 3Y, separately for each selected brokerage account. Omit accountId for all supported visible accounts. Preserves provider as-of/inception dates and identifies unavailable periods. Returns decimal strings in percent units (5 means 5%, not 500%); no averaging of account returns or inferred benchmark. Retrieval time is not the performance reporting date.',
      input: selection,
      annotations,
    },
    async ({ accountId }) => guarded(() => session.getPerformance(accountId)),
  );
  server.tool(
    {
      name: 'fidelity_get_balance_history',
      title: 'Get Fidelity account balance history',
      description:
        'Read dated historical account values, separately per supported visible brokerage account. Omit accountId for all accounts; range is 1M, YTD, 1Y or 3Y (default 1Y). Values are USD decimal strings; dates are YYYY-MM-DD, sorted ascending. Fidelity historical values use overnight pricing and include deposits/withdrawals, so balance changes are not investment returns. Unavailable or incomplete history fails explicitly.',
      input: selection.extend({ range: historyRangeSchema.default('1Y') }),
      annotations,
    },
    async ({ accountId, range }) => guarded(() => session.getBalanceHistory(accountId, range)),
  );
  return server;
}
