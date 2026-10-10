import type { AccountBalance } from '../bridge/protocol.js';

export function makeSnapshot(accounts: AccountBalance[], retrievedAt: string, accountId?: string) {
  const cents = accounts.reduce((sum, a) => sum + BigInt(a.totalAccountValue.replace('.', '')), 0n);
  const magnitude = cents < 0n ? -cents : cents;
  return {
    source: 'fidelity_internal_api',
    scope: accountId ? 'specific_brokerage_account' : 'all_visible_brokerage_accounts',
    scopeNote:
      'Visible Fidelity brokerage accounts, including brokerage IRAs. External, hidden and other account types are excluded. Omit accountId for all supported accounts.',
    freshnessNote:
      'Fetched from Fidelity for this call. Retrieval time is not a market-data timestamp; Fidelity data may lag.',
    retrievedAt,
    currency: 'USD',
    totalAccountValue: `${cents < 0n ? '-' : ''}${magnitude / 100n}.${String(magnitude % 100n).padStart(2, '0')}`,
    accounts,
  } as const;
}
