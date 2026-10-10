import { z } from 'zod';
import { makeSnapshot } from '../domain/balances.js';
import { FidelityError } from '../domain/errors.js';
import {
  accountIdSchema,
  accountsResultSchema,
  balanceResultSchema,
  positionsResultSchema,
  type FailureCode,
} from './protocol.js';

export type PortfolioOperation = 'list_accounts' | 'read_balance' | 'read_positions';

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
};

export function portfolioFailure(code: FailureCode): FidelityError {
  return new FidelityError(code, failureMessages[code]);
}

// Transports supply raw portfolio snapshots; validation and MCP results stay identical.
export abstract class PortfolioReader {
  protected abstract requestPortfolio(
    operation: PortfolioOperation,
    accountId?: string,
  ): Promise<unknown>;

  private async read<T extends { retrievedAt: string; accounts: Array<{ accountId: string }> }>(
    operation: PortfolioOperation,
    schema: z.ZodType<T>,
    accountId?: string,
  ): Promise<T> {
    if (accountId !== undefined) accountIdSchema.parse(accountId);
    const parsed = schema.safeParse(await this.requestPortfolio(operation, accountId));
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
}
