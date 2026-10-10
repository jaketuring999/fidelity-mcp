import { encodeMessage, MessageDecoder } from './framing.js';
import { createConnection, type Socket } from 'node:net';
import { readFile } from 'node:fs/promises';
import { localPaths } from '../runtime/paths.js';
import { commandSchema, responseSchema } from './protocol.js';

export async function runNativeHost(origin: string | undefined, base?: string): Promise<void> {
  const paths = localPaths(base);
  const config = JSON.parse(await readFile(paths.config, 'utf8')) as { extensionId: string };
  if (
    !/^[a-p]{32}$/.test(config.extensionId) ||
    origin !== `chrome-extension://${config.extensionId}/`
  )
    throw new Error('Unregistered extension');
  let socket: Socket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let ready = false;
  const send = (message: unknown) => {
    process.stdout.write(encodeMessage(message));
  };
  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    socket?.destroy();
  };
  const input = new MessageDecoder((message) => {
    const parsed = responseSchema.safeParse(message);
    if (!parsed.success) throw new Error('Invalid extension response');
    if (ready && socket && !socket.destroyed) socket.write(encodeMessage(parsed.data));
  });
  process.stdin.on('data', (chunk: Buffer) => {
    try {
      input.push(chunk);
    } catch {
      stop();
      process.exit(1);
    }
  });
  process.stdin.once('end', () => {
    stop();
    process.exit(0);
  });
  process.once('SIGTERM', () => {
    stop();
    process.exit(0);
  });
  const connect = async () => {
    if (stopped) return;
    const token = await readFile(paths.token, 'utf8').catch(() => '');
    if (stopped) return;
    if (!/^[0-9a-f]{64}$/.test(token)) {
      send({ type: 'status', connected: false });
      timer = setTimeout(() => void connect(), 1000);
      return;
    }
    socket = createConnection(paths.socket);
    const peer = socket;
    const decoder = new MessageDecoder((message) => {
      if ((message as { type?: unknown })?.type === 'connected') {
        ready = true;
        send({ type: 'status', connected: true });
        return;
      }
      const parsed = commandSchema.safeParse(message);
      if (!parsed.success || !ready) throw new Error('Invalid server command');
      send(parsed.data);
    });
    peer.once('connect', () => peer.write(encodeMessage({ type: 'hello', version: 1, token })));
    peer.on('data', (chunk) => {
      try {
        decoder.push(chunk);
      } catch {
        peer.destroy();
      }
    });
    peer.on('error', () => {});
    peer.on('close', () => {
      ready = false;
      if (!stopped) {
        send({ type: 'status', connected: false });
        timer = setTimeout(() => void connect(), 1000);
      }
    });
  };
  void connect();
}
