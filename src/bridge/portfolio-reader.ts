import { z } from 'zod';
import { makeSnapshot } from '../domain/balances.js';
import { FidelityError } from '../domain/errors.js';
import {
  accountIdSchema,
  accountsResultSchema,
  balanceResultSchema,
  positionsResultSchema,
  taxLotsResultSchema,
  performanceResultSchema,
  balanceHistoryResultSchema,
  symbolSchema,
  historyRangeSchema,
  type ReadOptions,
  type FailureCode,
} from './protocol.js';

export type PortfolioOperation =
  | 'list_accounts'
  | 'read_balance'
  | 'read_positions'
  | 'read_tax_lots'
  | 'read_performance'
  | 'read_balance_history';

const failureMessages: Record<FailureCode, string> = {
  AUTHENTICATION_REQUIRED:
    'Sign in and complete 2FA directly in your Fidelity Chrome tab, then retry.',
  API_CONTEXT_UNAVAILABLE:
    'Fidelity request context is unavailable. Reload your signed-in portfolio tab and retry.',
  API_RESPONSE_CHANGED:
    'Fidelity returned an unexpected or incomplete portfolio response. The API adapter may need updating.',
  BALANCE_UNAVAILABLE:
    'Fidelity’s balance request failed. Check your signed-in portfolio tab and retry.',
  PORTFOLIO_UNAVAILABLE:
    'Fidelity’s portfolio request failed. Check your signed-in portfolio tab and retry.',
  ACCOUNT_NOT_FOUND:
    'This account reference is unavailable. List accounts again and use a current accountId.',
  POSITION_NOT_FOUND:
    'This security is not held in the selected account. Read positions and use a current symbol.',
  RESPONSE_TOO_LARGE:
    'This portfolio response exceeds the bridge size limit. Select one account or a security with fewer lots; no partial results were returned.',
};

export function portfolioFailure(code: FailureCode): FidelityError {
  return new FidelityError(code, failureMessages[code]);
}

// Transports supply raw portfolio snapshots; validation and MCP results stay identical.
export abstract class PortfolioReader {
  protected abstract requestPortfolio(
    operation: PortfolioOperation,
    accountId?: string,
    options?: ReadOptions,
  ): Promise<unknown>;

  private async read<T extends { retrievedAt: string; accounts: Array<{ accountId: string }> }>(
    operation: PortfolioOperation,
    schema: z.ZodType<T>,
    accountId?: string,
    options?: ReadOptions,
  ): Promise<T> {
    if (accountId !== undefined) accountIdSchema.parse(accountId);
    const parsed = schema.safeParse(await this.requestPortfolio(operation, accountId, options));
    if (!parsed.success)
      throw new FidelityError(
        'INVALID_BRIDGE_RESPONSE',
        'Invalid portfolio response. Retry the read.',
      );
    const result = parsed.data;
    const age = Date.now() - Date.parse(result.retrievedAt);
    if (age < -5000 || age > 30_000)
      throw new FidelityError(
        'INVALID_BRIDGE_RESPONSE',
        'Outdated portfolio snapshot. Retry the read.',
      );
    if (
      new Set(result.accounts.map((account) => account.accountId)).size !==
        result.accounts.length ||
      (accountId && (result.accounts.length !== 1 || result.accounts[0]?.accountId !== accountId))
    )
      throw new FidelityError(
        'INVALID_BRIDGE_RESPONSE',
        'Unexpected portfolio account scope. Retry the read.',
      );
    return result;
  }

  listAccounts() {
    return this.read('list_accounts', accountsResultSchema);
  }

  async getBalance(accountId?: string) {
    const result = await this.read('read_balance', balanceResultSchema, accountId);
    return makeSnapshot(result.accounts, result.retrievedAt, accountId);
  }

  async getPositions(accountId?: string) {
    const result = await this.read('read_positions', positionsResultSchema, accountId);
    return {
      source: 'fidelity_internal_api',
      scope: accountId ? 'specific_brokerage_account' : 'all_visible_brokerage_accounts',
      retrievedAt: result.retrievedAt,
      currency: 'USD',
      freshnessNote:
        'Retrieval time is not a market-data timestamp; Fidelity prices and cost basis may lag.',
      accounts: result.accounts,
    } as const;
  }

  async getTaxLots(accountId: string, symbol: string) {
    const result = await this.read('read_tax_lots', taxLotsResultSchema, accountId, {
      symbol: symbolSchema.parse(symbol),
    });
    if (
      result.accounts[0]!.positions.some(
        (p) => p.symbol.toUpperCase() !== symbol.trim().toUpperCase(),
      )
    )
      throw new FidelityError(
        'INVALID_BRIDGE_RESPONSE',
        'Unexpected tax-lot security scope. Retry the read.',
      );
    return {
      source: 'fidelity_internal_api',
      currency: 'USD',
      scope: 'specific_brokerage_account',
      freshnessNote:
        'Open lots use Fidelity adjusted cost basis. Unavailable measures are omitted; this is not a tax filing calculation.',
      ...result,
    } as const;
  }

  async getPerformance(accountId?: string) {
    const result = await this.read('read_performance', performanceResultSchema, accountId);
    return {
      source: 'fidelity_internal_api',
      scope: accountId ? 'specific_brokerage_account' : 'all_visible_brokerage_accounts',
      returnUnit: 'percent',
      freshnessNote:
        'Fidelity cumulative time-weighted pretax net returns, reported separately per account. Retrieval time is not the performance as-of date; missing periods are unavailable, not zero.',
      ...result,
    } as const;
  }

  async getBalanceHistory(accountId?: string, range: ReadOptions['range'] = '1Y') {
    const result = await this.read('read_balance_history', balanceHistoryResultSchema, accountId, {
      range: historyRangeSchema.parse(range),
    });
    if (result.range !== range)
      throw new FidelityError(
        'INVALID_BRIDGE_RESPONSE',
        'Unexpected history range. Retry the read.',
      );
    return {
      source: 'fidelity_internal_api',
      currency: 'USD',
      scope: accountId ? 'specific_brokerage_account' : 'all_visible_brokerage_accounts',
      freshnessNote:
        'Historical account values use Fidelity overnight pricing and include deposits and withdrawals. Balance change is not investment return.',
      ...result,
    } as const;
  }
}
