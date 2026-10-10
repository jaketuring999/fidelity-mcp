import { z } from 'zod';

export const MAX_MESSAGE_BYTES = 256 * 1024;
export const MAX_PORTFOLIO_BYTES = MAX_MESSAGE_BYTES - 1024;

export const accountIdSchema = z.string().regex(/^acct_[a-f0-9]{32}$/);
export const historyRangeSchema = z.enum(['1M', 'YTD', '1Y', '3Y']);
export const symbolSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9 ./*^_$+-]+$/);
export type ReadOptions = { symbol?: string; range?: z.infer<typeof historyRangeSchema> };
export const commandSchema = z.discriminatedUnion('operation', [
  z
    .object({
      type: z.literal('command'),
      id: z.string().uuid(),
      operation: z.literal('read_tax_lots'),
      accountId: accountIdSchema,
      symbol: symbolSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('command'),
      id: z.string().uuid(),
      operation: z.literal('read_performance'),
      accountId: accountIdSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('command'),
      id: z.string().uuid(),
      operation: z.literal('read_balance_history'),
      accountId: accountIdSchema.optional(),
      range: historyRangeSchema,
    })
    .strict(),
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
  'API_CONTEXT_UNAVAILABLE',
  'API_RESPONSE_CHANGED',
  'BALANCE_UNAVAILABLE',
  'PORTFOLIO_UNAVAILABLE',
  'ACCOUNT_NOT_FOUND',
  'POSITION_NOT_FOUND',
  'RESPONSE_TOO_LARGE',
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
export const positionsResultSchema = z
  .object({
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

const dateSchema = z.iso.date();
const holdingTypeSchema = z.enum(['cash', 'margin', 'unknown']);
export const taxLotsResultSchema = z
  .object({
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
                    holdingType: holdingTypeSchema,
                    status: z.enum(['available', 'not_eligible']),
                    lots: z
                      .array(
                        z
                          .object({
                            lotNumber: z.number().int().nonnegative(),
                            dateAcquired: dateSchema.optional(),
                            acquisitionDateStatus: z.enum(['known', 'various', 'unavailable']),
                            holdingPeriodDate: dateSchema.optional(),
                            term: z.enum(['short', 'long', 'unknown']),
                            quantity: decimalSchema.optional(),
                            currentValue: decimalSchema.optional(),
                            averageCostBasis: decimalSchema.optional(),
                            costBasisTotal: decimalSchema.optional(),
                            totalGainLoss: decimalSchema.optional(),
                            totalGainLossPercent: decimalSchema.optional(),
                            isWashSale: z.boolean(),
                            isNearingLongTerm: z.boolean(),
                          })
                          .strict(),
                      )
                      .max(10000),
                  })
                  .strict(),
              )
              .min(1)
              .max(100),
          })
          .strict(),
      )
      .length(1),
  })
  .strict();

export const performanceResultSchema = z
  .object({
    retrievedAt: z.string().datetime(),
    accounts: z
      .array(
        accountSchema
          .extend({
            asOfDate: dateSchema.optional(),
            dailyAsOfDate: dateSchema.optional(),
            inceptionDate: dateSchema.optional(),
            calculationType: z.literal('TW'),
            taxType: z.literal('pretax'),
            returnFrequency: z.literal('D'),
            returns: z
              .array(
                z
                  .object({
                    period: historyRangeSchema,
                    startDate: dateSchema,
                    endDate: dateSchema,
                    netReturnPercent: decimalSchema.optional(),
                    benchmarkReturnPercent: decimalSchema.optional(),
                  })
                  .strict(),
              )
              .max(4),
            unavailablePeriods: z.array(historyRangeSchema).max(4),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

export const balanceHistoryResultSchema = z
  .object({
    retrievedAt: z.string().datetime(),
    range: historyRangeSchema,
    accounts: z
      .array(
        accountSchema
          .extend({
            balances: z
              .array(z.object({ date: dateSchema, value: decimalSchema }).strict())
              .max(2000),
            requestedDateRangeGainLoss: decimalSchema.optional(),
            requestedDateRangeGainLossPercent: decimalSchema.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
