# Fidelity API reference

Read this before changing a Fidelity adapter. This is an unofficial, partial reconstruction of the browser APIs consumed by this project, not an official Fidelity specification. Authentication and provider account numbers stay inside Chrome.

## Public reference

| File | Purpose |
| --- | --- |
| [shared-context.md](shared-context.md) | Account selection, runtime configuration, compression and normalization |
| [openapi.json](openapi.json) | Reconstructed contracts for balances, positions and their bootstrap requests |
| [examples.json](examples.json) | Synthetic decoded and wire requests/responses; no customer captures |
| [endpoint-catalog.json](endpoint-catalog.json) | Validated reads and source-discovered route candidates with evidence locations |

The implemented tools are `fidelity_list_accounts`, `fidelity_get_account_balance`, and `fidelity_get_positions`. Account listing uses `PortSumContainer.PicoService.getPersonContext()`; it is not an invented REST endpoint. Balances and positions accept an optional opaque `accountId`. Omitting it reads all supported visible brokerage accounts, including brokerage IRAs.

The schemas document consumed fields and permit additional provider properties. They do not establish support for other account types or adjacent services. Source-discovered routes have unvalidated request/response contracts and are not implemented tools.

## Local discovery evidence

Existing developer checkouts can also contain `raw/`, `graphql/`, `source-manifest.json`, `source-routes.json`, `source-http-calls.json`, `graphql-index.json`, and `inventory.md`. These downloaded application bundles, verbatim client documents, and generated indexes are ignored by Git and excluded from the package. They are intentionally absent from a public clone. The manifest records public source URLs, sizes and SHA-256 hashes; catalog offsets refer to the exact saved bundles. Old `verification.json` reports are historical local evidence, not a current test result.

Use that saved evidence for offline discovery when available. Inspect complete callers and request construction, rather than inferring semantics from a route name. Client GraphQL selections are not server introspection, and operation names alone do not establish read-only behavior. The one-off download/index/spec generator scripts have been removed; maintain the compact contracts alongside the adapters.

When local evidence is unavailable or insufficient, inspect live Chrome to validate the candidate and its request/response contract. Never save cookies, tokens, account identifiers, customer responses, HAR files or screenshots containing financial data in the public reference.

## Adding a read

1. Inspect the catalog, shared context, adapter source and available local raw/GraphQL evidence.
2. Reuse account selection, runtime bootstrap and gzip encoding. Keep full provider account numbers inside Chrome.
3. Exercise the new read through the MCP/native-host/extension E2E path with synthetic data, including incomplete responses and failures.
4. Validate the read in live Chrome before claiming provider compatibility. Record schema coverage and limitations without customer data.
5. Update the public contracts and E2E evidence together. Run `npm run check` and `npm test`; successful suites write repeatable reports to ignored `artifacts/`.
