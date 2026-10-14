# Shared browser/API context

The live implementation is [src/bridge/fidelity-api.ts](../../src/bridge/fidelity-api.ts). Its serialized function runs in the Chrome page MAIN world. The entry surface is a signed-in `https://digital.fidelity.com/ftgw/digital/portfolio/summary` page, rather than an independent bearer-token API.

## Account identity and selection

`await window.PortSumContainer.PicoService.getPersonContext()` returns `person.person.assets`. Our adapter selects assets where `acctType === 'Brokerage'` and `preferenceDetail.isHidden` is false/missing. Core fields used are `acctNum`, `acctType`, `acctSubType`, `preferenceDetail.name`, `acctTradeAttrDetail`, `acctLegalAttrDetail`, and margin flags under `acctFeature.featureDetails.established.marginOptionSpreadsDetail`.

The UI's `StateContext.current('currentAccount')` also carries selection/group state, including `allAccountList`, `selected`, `selectedVisibleAcctList`, and `accountState`. We intentionally derive “all accounts” from person assets so a highlighted UI account does not narrow an unfiltered MCP request.

MCP `accountId` is `acct_` plus the first 32 hex characters of SHA-256 of `salt + ':' + acctNum`. The browser bridge keeps the random 64-hex-character salt in server-process memory; IDs survive tab reloads and change when the server restarts. Clients should obtain IDs from `fidelity_list_accounts`, then pass one to balances/positions. Full provider account numbers remain in the page request.

## Runtime config and authentication

| Operation | Page config | Bootstrap if missing | Fields consumed |
| --- | --- | --- | --- |
| Balance | `window.balExpConfig` | `GET /ftgw/digital/balwebex/` | `ctoken`, `virtualmode`, `virtualbwe` |
| Positions | `window.posweb` | `GET /ftgw/digital/positions/poswebex/?snippet=Y` | `ctoken`, `user`, `virtualmode`, `virtualpwe` |

Bootstrap text is parsed for expected quoted values, not executed. Balance fallback uses `virtualmode=N`, `virtualbwe=multiple`; positions fallback uses `virtualmode=N`, `virtualpwe=multiple`. `posweb.user` is an opaque runtime customer context, not a JSON schema or reusable API credential.

Data POSTs use session cookies via `credentials: 'include'`, `Content-Type: application/json`, `X-CSRF-Token: ctoken`, `whereUsed: location.href`, and the operation's virtual headers. Positions additionally sends `Preset-View: StackOverView`. Reads use `cache: 'no-store'`, `redirect: 'error'`, and a 15-second abort signal. Config/tokens must be acquired at runtime; no captured value belongs in a fixture.

## Compressed bodies

Both services wrap JSON using **UTF-8 JSON → gzip → base64**. The compressed string is data, not encryption.

Balance request is `{picoString: encode(decodedAssets)}`. Each decoded element contains `account`, copied legal/trading attributes, account name, and margin flags. See `BalanceDecodedPico` in OpenAPI and the full adapter for construction.

Positions request includes `accts` (full provider numbers), `pico` (compressed decoded context), `externalCustId` (runtime `posweb.user`), `pzn: []`, `allTreatments: []`, `isBasketEnable: false`, `isGroupBySecurityEnable: false`, `isRefresh: true`, `settings: {groupBy:'0', filter:''}`, and `toggles: {}`. The minimal validated decoded pico contains:

```json
{
  "accounts": [{"accountId":"DEMO0001","acctType":"Brokerage","acctSubType":"DEMO","brokerageAccount":true}],
  "hasSPS": false,
  "pznFPLAccts": []
}
```

The browser's full legacy context carries many additional flags (retirement, HSA, annuity, advisor, registration, trading, linking, etc.). The minimal envelope was live validated only for our supported brokerage accounts. Do not assume it supports other asset types or every adjacent service.

## Response normalization

Balances return an array, matched by `account.acctNum`. `balance.totalAcctVal` is required; optional cash fields are documented in OpenAPI. Amounts are normalized to two decimal places and totalled using integer cents. Missing optional data remains missing.

Positions return `totalNoOfAccts`, `acctTot`, and `rowData`. Rows include `ACCOUNT`, `POSITION`, `POSITION_CORE`, `PENDING`, `ACCOUNT_TOTAL`, `SPACER`, and `GRAND_TOTAL`. Only the two position row types become holdings. `sym.name/desc` supplies symbol/description; `qty.val` and `curVal.val` supply quantity/value. `lstPrStk.top.val`, `cstBasStk.top.val`, `todGLStk.top.val`, and `totGLStk.top.val` supply price, total cost basis, daily gain/loss and total gain/loss. Stacked bottom values are secondary display measures; do not substitute them for totals. Core positions can omit quantity/price.

Coverage checks require the requested account set to match provider totals and account headers. Unexpected row types, malformed numbers, duplicate/missing accounts, or non-JSON data fail instead of producing a partial portfolio. Schemas here describe consumed/observed fields and allow additional provider properties; the runtime adapter enforces stricter coverage rules.

Optional position measures also use the display placeholders `--` and `n/a`; normalize these to missing, never zero. On 2026-10-10, live Chrome reproduced `--` in `totGLStk.top.val` and confirmed that omitting it passes the remaining portfolio coverage checks. The saved positions bundle recognizes both placeholders in numeric display/sort handling (local `raw/009adff600a3-posweb.1183c9b2491ae6824e3b.bundle.js`, offsets 25596 and 67807). Only `--` was observed in this live check; `n/a` support is source-backed. Required `curVal.val` remains numeric, and other malformed optional values still fail. No customer responses or identifiers are saved in this reference.

The supported entry route is defined in `src/domain/fidelity-page.ts` and used by both browser modes. Matching requires that exact origin and pathname; query strings and fragments do not change the route. Other portfolio descendants are not established by the current evidence and are refused before adapter injection. The serialized MAIN-world adapter receives this fixed policy from the transport and rechecks the current location in case navigation occurred after tab selection. This narrows route acceptance; it does not establish a new provider contract.

## Advanced reads (validated 2026-10-10)

The saved GraphQL selections describe fields but the current client routes `GetAcctPerf` and `BalanceHistory` through plain JSON POSTs at `/ftgw/digital/portfolio/api/GetAcctPerf` and `/ftgw/digital/portfolio/api/BalanceHistory`. Do not send a GraphQL envelope to these endpoints. The adapter uses same-origin session cookies, JSON content type, no-store and the same bounded abort signal. No additional token or cookies leave Chrome. The old `/api/graphql` route returned non-JSON in this validation and is not used. The cash-management facade was also observed but strips performance metadata and is not the implemented contract.

Local public-code evidence includes `raw/live-portsum-module-32765.js`: brokerage performance entities use `entityType:account` and `sourceSystemId:ICS` (offset 42607); request settings use TW, pretax, cumulative, NET, daily frequency and the four standard periods (offset 50333). Its percentage renderer formats the provider number directly with `%`, without multiplying by 100. `raw/live-portsum-module-30890.js` has plain-JSON request/response adapters for BalanceHistory (offset 556202) and GetAcctPerf (offset 568744). These are local runtime factory snapshots of public application code, not customer captures. The older exact client selections remain in `graphql/6495ef984ad8607f.graphql` and `graphql/c534cbe35a7cada1.graphql` when available.

Performance requests all visible supported accounts or one account with `isAggregate:false`, `includePartialInMonthlyFreq:false`, and fixed TW/pretax/cumulative/NET/D settings. Match unique entity IDs to the exact requested account set. Preserve as-of, daily-as-of and inception dates; missing periods or null returns are explicitly unavailable, never zero. Unknown calculation metadata, duplicate periods/entities, malformed dates/numbers and missing accounts fail. The tool does not infer a benchmark or combine account returns.

BalanceHistory aggregates its `acctList` without echoing account identity. The adapter requests each selected account separately, preserving per-account dated values rather than silently losing an account inside an aggregate. Reject system messages, missing/empty history, duplicate dates and malformed values; sort valid points ascending. Supported ranges are 1M, YTD, 1Y and 3Y, default 1Y. Values include deposits/withdrawals and overnight pricing; the reported balance change is not investment return.

Open lots use `/positions/poswebex/api/openlots-json` with the positions bootstrap and headers. Require one opaque accountId and a symbol held in that account. First read and validate scoped positions, then build the lot request using the row's CUSIP, holding type, security type and position measures. Local caller evidence is `raw/009adff600a3-posweb.1183c9b2491ae6824e3b.bundle.js`, offsets 648300–651074. Core or other positions not explicitly eligible for lots return `not_eligible`, not a fabricated empty available set.

Lots use adjusted basis (`isUnadjusted:false`), pages of 250, and a maximum of 40 pages/10,000 rows. Validate stable `totalLots`/`lastPage`, current/next page, unique lot indices and final row count. Changing totals, loops and incomplete results fail instead of returning page one as complete. Normalize number/display-string measures (currency, signs, grouped commas, parentheses, percentage suffixes) to decimal strings. Tax-lot dates use Mon-DD-YYYY, history/performance MM/DD/YYYY; validate and return ISO calendar dates. `Various` acquisition dates stay explicit; unknown measures remain missing. Preserve wash-sale and near-long-term flags without recomputing tax rules. Outputs exceeding the 255 KiB portfolio response budget return `RESPONSE_TOO_LARGE`; the browser connection remains usable.

Live OAuth/MCP validation exercised canonical schemas, all/every-single-account scope, all four history ranges and every held symbol. Sanitized reports record success, checks and limitations without customer values or identifiers. Synthetic real-Chromium E2E flows additionally exercise multi-page lots, formatted negatives, very small quantities, missing periods, malformed/partial/oversized responses and session expiry. Synthetic multi-page coverage does not establish that every live account type or optional feature is supported.
