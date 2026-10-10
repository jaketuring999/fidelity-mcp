import { FastMCP, ToolResult } from '@prefecthq/fastmcp-ts/server';
import { z } from 'zod';
import { FidelityError } from '../domain/errors.js';
import type { PortfolioReader } from '../bridge/portfolio-reader.js';
import { accountIdSchema } from '../bridge/protocol.js';

export function createServer(
  session: Pick<PortfolioReader, 'listAccounts' | 'getBalance' | 'getPositions'>,
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
  return server;
}
