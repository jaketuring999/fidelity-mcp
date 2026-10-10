import { encodeMessage, MessageDecoder } from './framing.js';
import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { chmod, lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { FidelityError } from '../domain/errors.js';
import { localPaths } from '../runtime/paths.js';
import { commandSchema, responseSchema, type BridgeCommand, type ReadOptions } from './protocol.js';
import { PortfolioReader, portfolioFailure, type PortfolioOperation } from './portfolio-reader.js';
import { z } from 'zod';
import { EventEmitter } from 'node:events';

export class ExtensionBridge extends PortfolioReader {
  private readonly paths;
  private server: Server | undefined;
  private peer: Socket | undefined;
  private readonly sockets = new Set<Socket>();
  private readonly pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly token = randomBytes(32).toString('hex');
  private closing = false;
  private ownsSocket = false;
  private readonly events = new EventEmitter();
  constructor(
    base?: string,
    private readonly log: (text: string) => void = (text) =>
      console.error(`[fidelity-mcp] ${text}`),
  ) {
    super();
    this.paths = localPaths(base);
  }
  get connected(): boolean {
    return Boolean(this.peer && !this.peer.destroyed);
  }
  async start(): Promise<void> {
    await mkdir(this.paths.base, { recursive: true, mode: 0o700 });
    await chmod(this.paths.base, 0o700);
    const existing = await lstat(this.paths.socket).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (existing) {
      if (!existing.isSocket())
        throw new FidelityError('BRIDGE_IN_USE', 'Bridge path is occupied by another file.');
      const active = await new Promise<boolean>((resolve) => {
        const socket = createConnection(this.paths.socket);
        socket.once('connect', () => {
          socket.destroy();
          resolve(true);
        });
        socket.once('error', () => resolve(false));
      });
      if (active)
        throw new FidelityError(
          'BRIDGE_IN_USE',
          'Another Fidelity MCP process is running. Close that connection before starting a new one.',
        );
      await unlink(this.paths.socket);
    }
    this.server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.paths.socket, () => {
        this.server!.removeListener('error', reject);
        resolve();
      });
    }).catch(() => {
      throw new FidelityError(
        'BRIDGE_IN_USE',
        'Could not start the local bridge. Check for another Fidelity MCP process.',
      );
    });
    this.ownsSocket = true;
    this.server.on('error', () =>
      this.log('Local bridge encountered an error. Restart the MCP connection.'),
    );
    await chmod(this.paths.socket, 0o600);
    await writeFile(this.paths.token, this.token, { mode: 0o600 });
    await chmod(this.paths.token, 0o600);
    this.log('Local bridge ready. Connect the Fidelity MCP extension in Chrome.');
  }
  private accept(socket: Socket): void {
    this.sockets.add(socket);
    let authenticated = false;
    const authenticationTimer = setTimeout(() => socket.destroy(), 5000);
    const decoder = new MessageDecoder((message) => {
      if (!authenticated) {
        const hello = message as { type?: unknown; token?: unknown; version?: unknown };
        if (
          !hello ||
          hello.type !== 'hello' ||
          hello.version !== 1 ||
          typeof hello.token !== 'string' ||
          hello.token.length !== this.token.length ||
          !timingSafeEqual(Buffer.from(hello.token), Buffer.from(this.token))
        ) {
          socket.destroy();
          return;
        }
        clearTimeout(authenticationTimer);
        if (this.peer && !this.peer.destroyed) {
          socket.destroy();
          return;
        }
        authenticated = true;
        this.peer = socket;
        socket.write(encodeMessage({ type: 'connected' }));
        this.log('Chrome extension connected.');
        this.events.emit('connected');
        return;
      }
      const parsed = responseSchema.safeParse(message);
      if (!parsed.success) {
        socket.destroy();
        return;
      }
      const response = parsed.data;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(portfolioFailure(response.code));
    });
    socket.on('data', (chunk) => {
      try {
        decoder.push(chunk);
      } catch {
        socket.destroy();
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(authenticationTimer);
      this.sockets.delete(socket);
      if (this.peer !== socket) return;
      this.peer = undefined;
      for (const item of this.pending.values()) {
        clearTimeout(item.timer);
        item.reject(
          new FidelityError(
            'EXTENSION_DISCONNECTED',
            'Chrome extension disconnected. Keep Chrome open; the extension reconnects automatically.',
          ),
        );
      }
      this.pending.clear();
      if (!this.closing) this.log('Chrome extension disconnected.');
    });
  }
  private async waitForConnection(signal: AbortSignal): Promise<void> {
    if (this.connected) return;
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        cleanup();
        resolve();
      };
      const aborted = () => {
        cleanup();
        reject(new Error('Connection cancelled.'));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Keep Chrome open so the extension can reconnect, then retry.'));
      }, 30_000);
      const cleanup = () => {
        clearTimeout(timer);
        this.events.removeListener('connected', done);
        signal.removeEventListener('abort', aborted);
      };
      this.events.once('connected', done);
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
    });
  }
  async connectFidelity(signal: AbortSignal): Promise<void> {
    await this.waitForConnection(signal);
    z.object({ connected: z.literal(true) })
      .strict()
      .parse(
        await this.send(
          {
            type: 'command',
            id: randomUUID(),
            operation: 'connect_fidelity',
            expiresAt: Date.now() + 270_000,
          },
          270_000,
          signal,
        ),
      );
  }
  private send(command: BridgeCommand, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (!this.connected)
      return Promise.reject(
        new FidelityError(
          'EXTENSION_DISCONNECTED',
          'Chrome extension is unavailable. Keep Chrome open and run fidelity-mcp setup if needed.',
        ),
      );
    const id = command.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const item = this.pending.get(id);
        this.pending.delete(id);
        item?.reject(
          new FidelityError(
            'BRIDGE_TIMEOUT',
            'Chrome did not respond in time. Check the Fidelity tab and retry.',
          ),
        );
      }, timeoutMs);
      const aborted = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('Request cancelled.'));
      };
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) {
        aborted();
        return;
      }
      this.pending.set(id, {
        timer,
        resolve: (value) => {
          signal?.removeEventListener('abort', aborted);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', aborted);
          reject(error);
        },
      });
      this.peer!.write(encodeMessage(command));
    });
  }
  protected requestPortfolio(
    operation: PortfolioOperation,
    accountId?: string,
    options: ReadOptions = {},
  ): Promise<unknown> {
    return this.send(
      commandSchema.parse({
        type: 'command',
        id: randomUUID(),
        operation,
        ...(accountId === undefined ? {} : { accountId }),
        ...options,
      }),
      25_000,
    );
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const socket of this.sockets) socket.destroy();
    if (this.server?.listening)
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    if (this.ownsSocket) {
      const token = await readFile(this.paths.token, 'utf8').catch(() => '');
      if (token === this.token) await unlink(this.paths.token).catch(() => {});
      this.ownsSocket = false;
    }
  }
}
