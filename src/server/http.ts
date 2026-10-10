import { createServer, type Server } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import type { FastMCP } from '@prefecthq/fastmcp-ts/server';
import {
  verifyBearerToken,
  bearerAuthChallengeResponse,
  type AuthInfo,
} from '@modelcontextprotocol/server';
import { LocalOAuth, PORTFOLIO_SCOPE } from './auth.js';
import { parseJsonObject } from './json.js';

const MAX_BODY_BYTES = 64 * 1024;
class BodyTooLarge extends Error {}
async function boundedBody(request: Request): Promise<string> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null && Number(declaredLength) > MAX_BODY_BYTES) throw new BodyTooLarge();
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new BodyTooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

// Loopback access checks surround FastMCP's always-stateless fetch handler.
// The adapter carries JSON and request-scoped SSE, including disconnect aborts.
export async function startHttpServer(
  mcp: FastMCP,
  options: { base: string; port: number; connectFidelity: (signal: AbortSignal) => Promise<void> },
) {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)
    throw new RangeError('Port must be an integer between 0 and 65535.');
  // The listener can run before OAuth initialization finishes.
  // eslint-disable-next-line prefer-const
  let oauth: LocalOAuth | undefined;
  let port = options.port;
  const active = new Set<AbortController>();
  let closing = false;
  const listener = getRequestListener(
    async (request, { outgoing }) => {
      const url = new URL(request.url);
      const authorities = ['127.0.0.1', 'localhost'].map(
        (host) => new URL(`http://${host}:${port}`).host,
      );
      const origin = request.headers.get('origin');
      const denied = (status: number, error: string, headers: Record<string, string> = {}) =>
        Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
      if (
        !authorities.includes(request.headers.get('host') ?? '') ||
        !authorities.includes(url.host)
      )
        return denied(403, 'Untrusted host.');
      if (origin !== null && !authorities.some((host) => origin === `http://${host}`))
        return denied(403, 'Untrusted origin.');
      if (closing || !oauth) return denied(503, 'Server is unavailable.');
      let authInfo: AuthInfo | undefined;
      if (url.pathname === '/mcp') {
        try {
          authInfo = await verifyBearerToken(request.headers.get('authorization'), {
            verifier: oauth,
            requiredScopes: [PORTFOLIO_SCOPE],
            expectedResource: new URL(oauth.resource),
            resourceMetadataUrl: `${oauth.origin}/.well-known/oauth-protected-resource/mcp`,
          });
        } catch (error) {
          const response = bearerAuthChallengeResponse(error, {
            resourceMetadataUrl: `${oauth.origin}/.well-known/oauth-protected-resource/mcp`,
          });
          response.headers.set('Cache-Control', 'no-store');
          return response;
        }
        if (request.method !== 'POST')
          return denied(405, 'Use POST for Streamable HTTP.', { Allow: 'POST' });
        if (
          request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
          'application/json'
        )
          return denied(415, 'Expected application/json.');
      }
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.signal.addEventListener('abort', abort, { once: true });
      if (request.signal.aborted) abort();
      active.add(controller);
      const cleanup = () => {
        active.delete(controller);
        request.signal.removeEventListener('abort', abort);
        outgoing.removeListener('finish', cleanup);
        outgoing.removeListener('close', disconnected);
      };
      const disconnected = () => {
        if (!outgoing.writableFinished) abort();
        cleanup();
      };
      outgoing.once('finish', cleanup);
      outgoing.once('close', disconnected);
      try {
        const body = ['GET', 'HEAD'].includes(request.method)
          ? undefined
          : await boundedBody(request);
        const forwarded = new Request(request.url, {
          method: request.method,
          headers: request.headers,
          ...(body === undefined ? {} : { body }),
          signal: controller.signal,
        });
        let response: Response;
        if (url.pathname === '/mcp') {
          parseJsonObject(body!);
          response = await mcp.fetch(forwarded, { authInfo: authInfo! });
        } else {
          response = (await oauth.handle(forwarded)) ?? denied(404, 'Not found.');
        }
        response.headers.set('Cache-Control', 'no-store');
        return response;
      } catch (error) {
        cleanup();
        if (error instanceof BodyTooLarge) return denied(413, 'MCP request exceeds 64 KiB.');
        if (error instanceof SyntaxError || error instanceof TypeError)
          return denied(400, 'Invalid JSON request.');
        return denied(500, 'MCP request failed.');
      }
    },
    { overrideGlobalObjects: false },
  );
  const server: Server = createServer(listener);
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP listener has no TCP address.');
  port = address.port;
  const url = `http://127.0.0.1:${port}/mcp`;
  oauth = new LocalOAuth(new URL(url).origin, options.base, options.connectFidelity);
  try {
    await oauth.initialize();
  } catch (error) {
    oauth.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
  let shutdown: Promise<void> | undefined;
  return {
    url,
    close(): Promise<void> {
      shutdown ??= (async () => {
        closing = true;
        oauth?.close();
        for (const controller of active) controller.abort();
        active.clear();
        const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeAllConnections();
        await stopped;
        await mcp.close();
      })();
      return shutdown;
    },
  };
}
