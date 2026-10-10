import { fetchFidelityPortfolio, type ReadOperation } from './fidelity-api.js';
import type { FailureCode } from '../../src/bridge/protocol.js';
import { commandSchema, MAX_PORTFOLIO_BYTES, type ReadOptions } from '../../src/bridge/protocol.js';

import {
  fidelityPage,
  portfolioUrl,
  fidelityTabPattern,
  isFidelityUrl,
  isPortfolioUrl,
} from '../../src/domain/fidelity-page.js';

const HOST = 'com.fidelity_mcp.bridge';
let nativePort: chrome.runtime.Port | undefined;
let queue: Promise<unknown> = Promise.resolve();
class TabError extends Error {
  constructor(public readonly code: FailureCode) {
    super(code);
  }
}
async function chooseTab(create: boolean): Promise<chrome.tabs.Tab> {
  const { selectedTab } = await chrome.storage.session.get('selectedTab');
  if (typeof selectedTab === 'number') {
    const tab = await chrome.tabs.get(selectedTab).catch(() => undefined);
    if (tab && isFidelityUrl(tab.url)) return tab;
    await chrome.storage.session.remove('selectedTab');
  }
  const tabs = await chrome.tabs.query({ url: fidelityTabPattern });
  tabs.sort(
    (a, b) =>
      Number(Boolean(b.active)) - Number(Boolean(a.active)) ||
      (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0),
  );
  if (tabs[0]) return tabs[0];
  if (create) return chrome.tabs.create({ url: portfolioUrl });
  throw new TabError('AUTHENTICATION_REQUIRED');
}
let saltPromise: Promise<string> | undefined;
function accountSalt(): Promise<string> {
  return (saltPromise ??= (async () => {
    const stored = await chrome.storage.session.get('accountSalt');
    if (typeof stored.accountSalt === 'string' && /^[a-f0-9]{64}$/.test(stored.accountSalt))
      return stored.accountSalt;
    const salt = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    await chrome.storage.session.set({ accountSalt: salt });
    return salt;
  })().catch((error) => {
    saltPromise = undefined;
    throw error;
  }));
}
async function readPortfolio(
  operation: ReadOperation,
  accountId?: string,
  tab?: chrome.tabs.Tab,
  options: ReadOptions = {},
): Promise<unknown> {
  tab ??= await chooseTab(false);
  if (tab.id === undefined || !tab.url) throw new TabError('AUTHENTICATION_REQUIRED');
  if (!isPortfolioUrl(tab.url)) throw new TabError('AUTHENTICATION_REQUIRED');
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: fetchFidelityPortfolio,
    args: [operation, accountId ?? null, await accountSalt(), fidelityPage, options],
    world: 'MAIN',
  });
  const result = results[0]?.result;
  if (!result) throw new TabError('PORTFOLIO_UNAVAILABLE');
  if (!result.ok) throw new TabError(result.code);
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_PORTFOLIO_BYTES)
    throw new TabError('RESPONSE_TOO_LARGE');
  const { ok: _ok, ...snapshot } = result;
  return snapshot;
}

async function connectFidelity(
  port: chrome.runtime.Port,
  expiresAt: number,
): Promise<{ connected: true }> {
  const tab = await chooseTab(true);
  if (tab.id === undefined) throw new TabError('BALANCE_UNAVAILABLE');
  const id = tab.id;
  await chrome.storage.session.set({ selectedTab: id });
  await chrome.tabs.update(id, {
    active: true,
    ...(!isPortfolioUrl(tab.url) ? { url: portfolioUrl } : {}),
  });
  await chrome.windows.update(tab.windowId, { focused: true });
  // Poll this same tab across sign-in/2FA redirects. Neither credentials nor the
  // readiness check's balances are sent to the local server.
  while (Date.now() < expiresAt && nativePort === port) {
    const current = await chrome.tabs.get(id).catch(() => undefined);
    if (!current) throw new TabError('AUTHENTICATION_REQUIRED');
    try {
      await readPortfolio('read_balance', undefined, current);
      if (nativePort !== port || Date.now() >= expiresAt) break;
      return { connected: true };
    } catch (error) {
      if (error instanceof TabError && error.code === 'API_RESPONSE_CHANGED') throw error;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  throw new TabError('AUTHENTICATION_REQUIRED');
}

function ensureNative(): void {
  if (nativePort) return;
  const port = chrome.runtime.connectNative(HOST);
  nativePort = port;
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError; // Consume the error without logging provider text.
    if (nativePort !== port) return;
    nativePort = undefined;
  });
  port.onMessage.addListener((message: unknown) => {
    const data = message as {
      type?: unknown;
      id?: unknown;
      operation?: unknown;
      expiresAt?: unknown;
      accountId?: unknown;
    };
    if (
      data?.type !== 'command' ||
      typeof data.id !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(data.id)
    )
      return;
    if (data.operation === 'connect_fidelity') {
      if (
        typeof data.expiresAt !== 'number' ||
        !Number.isSafeInteger(data.expiresAt) ||
        data.expiresAt <= Date.now() ||
        data.expiresAt > Date.now() + 300_000
      )
        return;
      const id = data.id;
      void connectFidelity(port, data.expiresAt)
        .then((result) => {
          if (nativePort === port) port.postMessage({ type: 'response', id, ok: true, result });
        })
        .catch((error) => {
          if (nativePort === port)
            port.postMessage({
              type: 'response',
              id,
              ok: false,
              code: error instanceof TabError ? error.code : 'BALANCE_UNAVAILABLE',
            });
        });
      return;
    }
    const parsed = commandSchema.safeParse(message);
    if (!parsed.success || parsed.data.operation === 'connect_fidelity') return;
    const command = parsed.data;
    const operation = command.operation;
    const accountId = command.operation === 'list_accounts' ? undefined : command.accountId;
    const options: ReadOptions =
      command.operation === 'read_tax_lots'
        ? { symbol: command.symbol }
        : command.operation === 'read_balance_history'
          ? { range: command.range }
          : {};
    // The server can request only these fixed operations, never arbitrary script.
    queue = queue
      .then(async () => {
        try {
          const result = await readPortfolio(operation, accountId, undefined, options);
          if (nativePort === port)
            port.postMessage({ type: 'response', id: data.id, ok: true, result });
        } catch (error) {
          const code = error instanceof TabError ? error.code : 'BALANCE_UNAVAILABLE';
          if (nativePort === port)
            port.postMessage({ type: 'response', id: data.id, ok: false, code });
        }
      })
      .catch(() => {});
  });
}
chrome.runtime.onInstalled.addListener(() => {
  ensureNative();
  void chrome.alarms.create('reconnect', { periodInMinutes: 0.5 });
});
chrome.runtime.onStartup.addListener(ensureNative);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'reconnect') ensureNative();
});

// Reconnect whenever Chrome starts or wakes this worker, without manual controls.
ensureNative();
