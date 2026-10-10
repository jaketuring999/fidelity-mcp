# Shared browser/API context

The live implementation is [extension/src/fidelity-api.ts](../../extension/src/fidelity-api.ts). Its serialized function runs in the Chrome page MAIN world. The entry surface is a signed-in `https://digital.fidelity.com/ftgw/digital/portfolio/summary` page, rather than an independent bearer-token API.

## Account identity and selection

`await window.PortSumContainer.PicoService.getPersonContext()` returns `person.person.assets`. Our adapter selects assets where `acctType === 'Brokerage'` and `preferenceDetail.isHidden` is false/missing. Core fields used are `acctNum`, `acctType`, `acctSubType`, `preferenceDetail.name`, `acctTradeAttrDetail`, `acctLegalAttrDetail`, and margin flags under `acctFeature.featureDetails.established.marginOptionSpreadsDetail`.

The UI's `StateContext.current('currentAccount')` also carries selection/group state, including `allAccountList`, `selected`, `selectedVisibleAcctList`, and `accountState`. We intentionally derive “all accounts” from person assets so a highlighted UI account does not narrow an unfiltered MCP request.

MCP `accountId` is `acct_` plus the first 32 hex characters of SHA-256 of `salt + ':' + acctNum`. The random 64-hex-character salt is stored in `chrome.storage.session`; IDs survive worker/tab reloads and change after a browser restart. Clients should obtain IDs from `fidelity_list_accounts`, then pass one to balances/positions. Full provider account numbers remain in the page request.

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

The supported entry route is defined in `src/domain/fidelity-page.ts` and shared by both transports. Matching requires that exact origin and pathname; query strings and fragments do not change the route. Other portfolio descendants are not established by the current evidence and are refused before adapter injection. The serialized MAIN-world adapter receives this fixed policy from the transport and rechecks the current location in case navigation occurred after tab selection. This narrows route acceptance; it does not establish a new provider contract.
