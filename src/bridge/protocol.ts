import { z } from 'zod';

export const accountIdSchema = z.string().regex(/^acct_[a-f0-9]{32}$/);
export const commandSchema = z.discriminatedUnion('operation', [
  z
    .object({
      type: z.literal('command'),
      id: z.string().uuid(),
      operation: z.literal('read_balance'),
      accountId: accountIdSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('command'),
      id: z.string().uuid(),
      operation: z.literal('read_positions'),
      accountId: accountIdSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('command'),
      id: z.string().uuid(),
      operation: z.literal('list_accounts'),
    })
    .strict(),
  z
    .object({
      type: z.literal('command'),
      id: z.string().uuid(),
      operation: z.literal('connect_fidelity'),
      expiresAt: z.number().int().positive(),
    })
    .strict(),
]);
export type BridgeCommand = z.infer<typeof commandSchema>;
const failureCodeSchema = z.enum([
  'AUTHENTICATION_REQUIRED',
  'MULTIPLE_FIDELITY_TABS',
  'API_CONTEXT_UNAVAILABLE',
  'API_RESPONSE_CHANGED',
  'BALANCE_UNAVAILABLE',
  'PORTFOLIO_UNAVAILABLE',
  'ACCOUNT_NOT_FOUND',
]);
export type FailureCode = z.infer<typeof failureCodeSchema>;
export const responseSchema = z.discriminatedUnion('ok', [
  z
    .object({
      type: z.literal('response'),
      id: z.string().uuid(),
      ok: z.literal(true),
      result: z.unknown(),
    })
    .strict(),
  z
    .object({
      type: z.literal('response'),
      id: z.string().uuid(),
      ok: z.literal(false),
      code: failureCodeSchema,
    })
    .strict(),
]);
const moneySchema = z.string().regex(/^-?\d{1,15}\.\d{2}$/);
export const balanceResultSchema = z
  .object({
    endpoint: z.literal('https://digital.fidelity.com/ftgw/digital/balwebex/api/balances'),
    retrievedAt: z.string().datetime(),
    accounts: z
      .array(
        z
          .object({
            accountId: accountIdSchema,
            last4: z.string().regex(/^[A-Za-z0-9]{4}$/),
            name: z.string().min(1).max(200),
            totalAccountValue: moneySchema,
            cashAvailableToTrade: moneySchema.optional(),
            settledCash: moneySchema.optional(),
            cashAvailableToWithdraw: moneySchema.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
const accountSchema = z
  .object({
    accountId: accountIdSchema,
    last4: z.string().regex(/^[A-Za-z0-9]{4}$/),
    name: z.string().min(1).max(200),
    accountType: z.literal('Brokerage'),
  })
  .strict();
export const accountsResultSchema = z
  .object({
    source: z.literal('fidelity_browser_context'),
    scope: z.literal('all_visible_brokerage_accounts'),
    retrievedAt: z.string().datetime(),
    accounts: z.array(accountSchema).max(100),
  })
  .strict();
const decimalSchema = z.string().regex(/^-?\d{1,15}(?:\.\d{1,10})?$/);
const POSITIONS_ENDPOINT =
  'https://digital.fidelity.com/ftgw/digital/positions/poswebex/api/positions';
export const positionsResultSchema = z
  .object({
    endpoint: z.literal(POSITIONS_ENDPOINT),
    retrievedAt: z.string().datetime(),
    accounts: z
      .array(
        accountSchema
          .extend({
            positions: z
              .array(
                z
                  .object({
                    symbol: z.string().min(1).max(100),
                    description: z.string().max(500),
                    quantity: decimalSchema.optional(),
                    lastPrice: decimalSchema.optional(),
                    currentValue: decimalSchema,
                    costBasis: decimalSchema.optional(),
                    todayGainLoss: decimalSchema.optional(),
                    totalGainLoss: decimalSchema.optional(),
                    holdingType: z.enum(['cash', 'margin', 'unknown']),
                  })
                  .strict(),
              )
              .max(5000),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

export type AccountBalance = z.infer<typeof balanceResultSchema>['accounts'][number];
export type AccountInfo = z.infer<typeof accountSchema>;
export type AccountsSnapshot = z.infer<typeof accountsResultSchema>;
