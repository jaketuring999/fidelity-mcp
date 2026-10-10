import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { localPaths } from '../runtime/paths.js';
import { FidelityError } from '../domain/errors.js';
import { makeSnapshot } from '../domain/balances.js';
import {
  accountIdSchema,
  accountsResultSchema,
  balanceResultSchema,
  positionsResultSchema,
  responseSchema,
} from './protocol.js';

const PORTFOLIO = 'https://digital.fidelity.com/ftgw/digital/portfolio/summary';
function isPortfolio(page: Page): boolean {
  try {
    const url = new URL(page.url());
    return (
      url.origin === 'https://digital.fidelity.com' &&
      url.pathname.startsWith('/ftgw/digital/portfolio/')
    );
  } catch {
    return false;
  }
}

// Playwright owns a dedicated profile or attaches to user-approved everyday Chrome.
// Only our fixed adapter is evaluated; no cookie export or extension/native host.
export class BrowserBridge {
  private context: BrowserContext | undefined;
  private selected: Page | undefined;
  private attachedBrowser: Browser | undefined;
  private readonly salt = randomBytes(32).toString('hex');
  private adapter = '';
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly base = localPaths().base,
    private readonly options: {
      headless?: boolean;
      channel?: string;
      attach?: boolean;
      cdpEndpoint?: string;
    } = {},
  ) {}
  async start(): Promise<void> {
    this.adapter = await readFile(new URL('./browser-adapter.js', import.meta.url), 'utf8');
    if (this.options.attach) {
      try {
        this.attachedBrowser = await chromium.connectOverCDP(this.options.cdpEndpoint ?? 'chrome', {
          noDefaults: true,
          timeout: 60_000,
        });
        this.context = this.attachedBrowser.contexts()[0];
        if (!this.context) throw new Error('No browser context');
        return;
      } catch {
        await this.attachedBrowser?.close().catch(() => {});
        this.attachedBrowser = undefined;
        this.context = undefined;
        throw new FidelityError(
          'PORTFOLIO_UNAVAILABLE',
          [
            'Could not connect to Chrome remote debugging. Chrome may be closed, remote debugging may be disabled, or its connection prompt was not approved.',
            'To connect with --bridge chrome-debugging:',
            '1. Open Google Chrome 144 or newer normally.',
            '2. Open chrome://inspect/#remote-debugging.',
            '3. Check "Allow remote debugging for this browser instance" and wait for "Server running at: 127.0.0.1:…".',
            '4. Rerun your server command with --bridge chrome-debugging, then click "Allow" in Chrome\'s connection prompt.',
            'If the page stays at "starting…", save your work, fully quit Chrome, and reopen it normally without --remote-debugging-port or --remote-debugging-pipe launch flags.',
            'Remote debugging grants browser-wide access; approve only trusted local apps.',
          ].join('\n'),
        );
      }
    }
    const profile = join(this.base, 'browser-profile');
    await mkdir(profile, { recursive: true, mode: 0o700 });
    await chmod(this.base, 0o700);
    await chmod(profile, 0o700);
    try {
      this.context = await chromium.launchPersistentContext(profile, {
        channel: this.options.channel ?? 'chrome',
        headless: this.options.headless ?? false,
      });
    } catch {
      throw new FidelityError(
        'PORTFOLIO_UNAVAILABLE',
        'Could not launch the dedicated Chrome profile. Close another browser-mode process and check Chrome is installed.',
      );
    }
  }
  private async page(create: boolean): Promise<Page> {
    if (!this.context?.browser()?.isConnected())
      throw new FidelityError(
        'PORTFOLIO_UNAVAILABLE',
        'Chrome connection closed. Restart the browser bridge.',
      );
    if (this.selected && !this.selected.isClosed() && isPortfolio(this.selected))
      return this.selected;
    const page = this.context.pages().find(isPortfolio);
    if (page) return (this.selected = page);
    if (!create)
      throw new FidelityError(
        'AUTHENTICATION_REQUIRED',
        'Sign in to Fidelity in the connected Chrome window.',
      );
    this.selected = await this.context.newPage();
    await this.selected.goto(PORTFOLIO, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    return this.selected;
  }
  private async snapshot(
    operation: 'list_accounts' | 'read_balance' | 'read_positions',
    accountId?: string,
    selected?: Page,
  ): Promise<unknown> {
    if (accountId !== undefined) accountIdSchema.parse(accountId);
    const page = selected ?? (await this.page(false));
    if (!isPortfolio(page))
      throw new FidelityError(
        'AUTHENTICATION_REQUIRED',
        'Sign in and complete 2FA in the connected Chrome window.',
      );
    let raw: unknown;
    try {
      raw = await page.evaluate(
        `${this.adapter}\n(async () => {
          let timer;
          try {
            return await Promise.race([
              FidelityReadAdapter.fetchFidelityPortfolio(${JSON.stringify(operation)},${JSON.stringify(accountId ?? null)},${JSON.stringify(this.salt)}),
              new Promise(resolve => { timer = setTimeout(() => resolve({ok:false,code:'PORTFOLIO_UNAVAILABLE'}), 25000); })
            ]);
          } finally { clearTimeout(timer); }
        })()`,
      );
    } catch {
      throw new FidelityError(
        'PORTFOLIO_UNAVAILABLE',
        'Browser read interrupted. Check the connected Fidelity tab and retry.',
      );
    }
    const failure = z
      .object({ ok: z.literal(false), code: z.string() })
      .strict()
      .safeParse(raw);
    if (failure.success) {
      const parsed = responseSchema.safeParse({
        type: 'response',
        id: '00000000-0000-4000-8000-000000000000',
        ...failure.data,
      });
      if (parsed.success && !parsed.data.ok)
        throw new FidelityError(
          parsed.data.code,
          'Fidelity read failed. Check the connected signed-in browser tab and retry.',
        );
    }
    const success = z
      .object({ ok: z.literal(true) })
      .passthrough()
      .safeParse(raw);
    if (!success.success)
      throw new FidelityError('INVALID_BRIDGE_RESPONSE', 'Invalid browser adapter response.');
    const { ok: _ok, ...result } = success.data;
    return result;
  }
  async connectFidelity(signal: AbortSignal): Promise<void> {
    const page = await this.page(true);
    await page.bringToFront();
    const deadline = Date.now() + 270_000;
    while (!signal.aborted && Date.now() < deadline && !page.isClosed()) {
      try {
        balanceResultSchema.parse(await this.snapshot('read_balance', undefined, page));
        if (signal.aborted) break;
        return;
      } catch (error) {
        if (error instanceof FidelityError && error.code === 'API_RESPONSE_CHANGED') throw error;
      }
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, 1500);
        signal.addEventListener('abort', done, { once: true });
        if (signal.aborted) done();
      });
    }
    throw new FidelityError(
      'AUTHENTICATION_REQUIRED',
      'Complete Fidelity sign-in in connected Chrome, then retry.',
    );
  }
  private read<T extends { retrievedAt: string; accounts: Array<{ accountId: string }> }>(
    operation: 'list_accounts' | 'read_balance' | 'read_positions',
    schema: z.ZodType<T>,
    accountId?: string,
  ): Promise<T> {
    const run = this.queue.then(async () => {
      const parsed = schema.safeParse(await this.snapshot(operation, accountId));
      if (!parsed.success)
        throw new FidelityError(
          'INVALID_BRIDGE_RESPONSE',
          'Unexpected browser portfolio response.',
        );
      const result = parsed.data;
      const age = Date.now() - Date.parse(result.retrievedAt);
      if (
        age < -5000 ||
        age > 30_000 ||
        new Set(result.accounts.map((a) => a.accountId)).size !== result.accounts.length ||
        (accountId && (result.accounts.length !== 1 || result.accounts[0]?.accountId !== accountId))
      )
        throw new FidelityError(
          'INVALID_BRIDGE_RESPONSE',
          'Unexpected browser account scope or snapshot age.',
        );
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
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
  async close(): Promise<void> {
    if (this.options.attach) await this.attachedBrowser?.close();
    else await this.context?.close();
  }
}
