# Tool reference

[Back to the overview](../README.md).

All-account reads cover visible supported Fidelity brokerage accounts, including brokerage IRAs, regardless of the account highlighted in Chrome. Hidden accounts, external accounts, and other account types are excluded. Account numbers are masked.

## Tools and account selection

| Tool                           | Parameters                                    | Result                                                                                     |
| ------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `fidelity_list_accounts`       | `{}`                                          | Supported account names, masked suffixes, type and opaque accountIds.                      |
| `fidelity_get_account_balance` | `{}` or `{ "accountId": "acct_…" }`           | All supported accounts or one account, with an exact total and separate cash fields.       |
| `fidelity_get_positions`       | `{}` or `{ "accountId": "acct_…" }`           | Holdings grouped by all supported accounts or one account.                                 |
| `fidelity_get_tax_lots`        | `{ "accountId": "acct_…", "symbol": "AAPL" }` | All open lots for that held security, separated by cash/margin holding.                    |
| `fidelity_get_performance`     | `{}` or `{ "accountId": "acct_…" }`           | Per-account cumulative time-weighted pretax net returns for 1M, YTD, 1Y and 3Y.            |
| `fidelity_get_balance_history` | `{ "range": "1M", "accountId": "acct_…" }`    | Dated account values; both fields optional, default range 1Y. Supports 1M, YTD, 1Y and 3Y. |

Use the complete `accountId` returned by the accounts tool; the ellipsis above is illustrative. Restarting the server changes account references. List accounts again after a restart. Unknown references return `ACCOUNT_NOT_FOUND`, and empty strings or raw account numbers are invalid inputs. Last-four suffixes can collide and are not lookup keys.

Tax lots require a symbol from the selected account's positions. The tool reads every page, normalizes display currencies and percentages to decimal strings, preserves wash-sale flags and distinguishes ineligible holdings from available lots. Dates use `YYYY-MM-DD`; unavailable fields remain omitted. Basis is adjusted as reported by Fidelity. `RESPONSE_TOO_LARGE` explicitly rejects results exceeding the bounded bridge size without returning a partial set or disconnecting it.

Performance preserves Fidelity's reporting dates and marks unavailable periods. Returns are percentage units: `"5"` means 5%. Returns remain separate per account; the tool does not average them. Balance history also remains separate per account and includes cash flows, so balance changes are not investment returns. These tools read data and do not trade, transfer, reassign lots or save Fidelity preferences.

## Balance results

Results include `source: fidelity_internal_api`, `scope: all_visible_brokerage_accounts` or `specific_brokerage_account`, `currency`, `retrievedAt`, `totalAccountValue`, and `accounts`. Each account has an opaque accountId, a name, the last four account-number characters, and its account value. Optional fields are:

- `cashAvailableToTrade`: explicit trade cash, excluding margin buying power.
- `settledCash`: included when Fidelity provides it.
- `cashAvailableToWithdraw`: cash-only withdrawal availability, excluding margin borrowing.

Totals use integer cents. Missing values or incomplete responses return errors instead of partial totals or invented zeroes. Retrieval time is not a market-data timestamp; Fidelity data may lag. The browser adapter calls Fidelity's internal balances API, whose routes and response shapes can change.

## Positions results

Positions include symbol, description, current value, and cash/margin classification. Quantity, last price, cost basis, daily gain/loss and unrealized gain/loss are included when supplied. Decimal strings preserve share and price precision; account headers, pending activity and totals are not holdings. Core cash is retained as a separate holding. Reads fetch Fidelity's internal positions API without navigating, using bootstrap configuration as text when necessary. Complete, valid account coverage is required; unexpected shapes return an error.

Retrieval time is not quote time. These reads are not an atomic snapshot across tools, and market prices/cost basis can lag.
