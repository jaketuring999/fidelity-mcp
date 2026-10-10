import { randomBytes } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { betterAuth, type BetterAuthPlugin } from 'better-auth';
import { createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { getMigrations } from 'better-auth/db/migration';
import { jwt } from 'better-auth/plugins';
import { mcp } from '@better-auth/mcp';
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import { verifyOAuthQueryParams } from '@better-auth/oauth-provider';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import { z } from 'zod';
import { OAuthError, OAuthErrorCode, type AuthInfo } from '@modelcontextprotocol/server';
import { parseJsonObject } from './json.js';

export const PORTFOLIO_SCOPE = 'fidelity:portfolio:read';
const opaque = () => randomBytes(32).toString('base64url');
const noStore = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};
const rateLimitedRoutes: Record<string, { method: string; limit: number }> = {
  '/connect': { method: 'GET', limit: 30 },
  '/auth/oauth2/register': { method: 'POST', limit: 30 },
  '/auth/oauth2/authorize': { method: 'GET', limit: 120 },
  '/auth/oauth2/token': { method: 'POST', limit: 120 },
  '/auth/oauth2/revoke': { method: 'POST', limit: 60 },
};
const rateLimitWindowMs = 60_000;
// Cursor registers this exact hosted callback alongside its loopback callback.
// Keep remote callbacks restricted to this path, rather than an entire domain.
const CURSOR_CALLBACK = 'https://www.cursor.com/agents/mcp/oauth/callback';
const allowedRedirect = (value: string) => value === CURSOR_CALLBACK || localRedirect(value);
const localRedirect = (value: string) => {
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
};
function makeAuth(origin: string, secret: string, database: DatabaseSync) {
  return betterAuth({
    baseURL: origin,
    basePath: '/auth',
    secret,
    database,
    trustedOrigins: [origin],
    logger: { disabled: true },
    session: {
      expiresIn: 30 * 24 * 3600,
      cookieCache: { enabled: false },
      additionalFields: { refreshGrant: { type: 'boolean', defaultValue: false, input: false } },
    },
    plugins: [
      jwt({ jwt: { issuer: origin } }),
      mcp({
        resource: `${origin}/mcp`,
        loginPage: '/connect',
        consentPage: '/connect',
        scopes: [PORTFOLIO_SCOPE, 'offline_access'],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationDefaultScopes: [PORTFOLIO_SCOPE, 'offline_access'],
        clientRegistrationAllowedScopes: [PORTFOLIO_SCOPE, 'offline_access'],
        clientRegistrationRequirePKCE: true,
        accessTokenExpiresIn: 900,
        refreshTokenExpiresIn: 30 * 24 * 3600,
        dpop: { signingAlgorithms: [] }, // This local resource accepts bearer tokens only.
        refreshTokenReuseInterval: 0,
        codeExpiresIn: 600,
      }) as unknown as BetterAuthPlugin,
      cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' }),
      {
        id: 'local-extension-owner',
        endpoints: {
          // This endpoint is called only through the in-process API AFTER native
          // connection. It is never exposed by the HTTP router.
          localOwnerSession: createAuthEndpoint(
            '/local-owner-session',
            { method: 'POST', body: z.object({ refreshGrant: z.boolean() }) },
            async (ctx) => {
              const found = await ctx.context.internalAdapter.findUserByEmail(
                'owner@fidelity-mcp.invalid',
              );
              const user =
                found?.user ??
                (await ctx.context.internalAdapter.createUser(
                  {
                    name: 'Local Fidelity owner',
                    email: 'owner@fidelity-mcp.invalid',
                    emailVerified: true,
                  },
                  { method: 'local-extension' },
                ));
              const session = await ctx.context.internalAdapter.createSession(
                user.id,
                false,
                { refreshGrant: ctx.body.refreshGrant },
                true,
              );
              await setSessionCookie(ctx, { session, user });
              return ctx.json({ ok: true });
            },
          ),
        },
      },
    ],
  });
}
type Auth = ReturnType<typeof makeAuth>;

// Better Auth owns OAuth discovery, client registration/CIMD, PKCE, durable
// grants, signing and refresh. This adapter completes a connection after verifying the
// authenticated Chrome extension. Owner session cookies stay inside this process.
export class LocalOAuth {
  readonly resource: string;
  private auth: Auth | undefined;
  private database: DatabaseSync | undefined;
  private secret = '';
  private initialized = false;
  private readonly active = new Set<AbortController>();
  constructor(
    readonly origin: string,
    private readonly base: string,
    private readonly connectFidelity: (signal: AbortSignal) => Promise<void>,
  ) {
    this.resource = `${origin}/mcp`;
  }
  async initialize(): Promise<void> {
    const secretPath = join(this.base, 'auth-secret');
    try {
      await writeFile(secretPath, opaque(), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await chmod(secretPath, 0o600);
    this.secret = (await readFile(secretPath, 'utf8')).trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(this.secret))
      throw new Error('Local auth secret is invalid or corrupted.');
    const secretBytes = Buffer.from(this.secret, 'base64url');
    if (secretBytes.length !== 32 || secretBytes.toString('base64url') !== this.secret)
      throw new Error('Local auth secret is invalid or corrupted.');
    const path = join(this.base, 'auth.sqlite');
    this.database = new DatabaseSync(path);
    await chmod(path, 0o600);
    this.auth = makeAuth(this.origin, this.secret, this.database);
    await (await getMigrations(this.auth.options)).runMigrations();
    await this.auth.$context;
    this.database.exec(
      'CREATE TABLE IF NOT EXISTS localOAuthRateLimit (route TEXT NOT NULL, requestedAt INTEGER NOT NULL)',
    );
    this.initialized = true;
  }
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    try {
      const auth = this.auth!;
      const jwksResponse = await auth.handler(new Request(`${this.origin}/auth/jwks`));
      const { payload } = await jwtVerify(
        token,
        createLocalJWKSet((await jwksResponse.json()) as JSONWebKeySet),
        { issuer: this.origin, audience: this.resource },
      );
      if (
        payload.cnf ||
        typeof payload.sid !== 'string' ||
        typeof payload.exp !== 'number' ||
        typeof payload.scope !== 'string' ||
        typeof payload.azp !== 'string'
      )
        throw new Error('Unsupported token.');
      const context = await auth.$context;
      const session = await context.adapter.findOne<{ expiresAt: Date; refreshGrant: boolean }>({
        model: 'session',
        where: [{ field: 'id', value: payload.sid }],
      });
      if (!session || session.expiresAt <= new Date()) throw new Error('Grant revoked.');
      // The grant marker survives clients narrowing the access-token scopes.
      if (session.refreshGrant) {
        const refresh = await context.adapter.findOne<{ expiresAt: Date }>({
          model: 'oauthRefreshToken',
          where: [
            { field: 'sessionId', value: payload.sid },
            { field: 'clientId', value: payload.azp },
            { field: 'revoked', value: null },
          ],
        });
        if (!refresh || refresh.expiresAt <= new Date()) throw new Error('Grant revoked.');
      }
      return {
        token,
        clientId: payload.azp,
        scopes: payload.scope.split(' '),
        expiresAt: payload.exp,
        resource: new URL(this.resource),
      };
    } catch {
      throw new OAuthError(OAuthErrorCode.InvalidToken, 'Token is expired, revoked or unknown.');
    }
  }
  async handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    const json = (value: unknown, status = 200, extraHeaders: Record<string, string> = {}) =>
      Response.json(value, { status, headers: { ...noStore, ...extraHeaders } });
    if (!this.initialized) return json({ error: 'temporarily_unavailable' }, 503);
    const routeLimit = rateLimitedRoutes[url.pathname];
    if (routeLimit?.method === request.method) {
      const retryAfter = this.recordRequest(url.pathname);
      if (retryAfter !== undefined)
        return json({ error: 'temporarily_unavailable' }, 429, {
          'Retry-After': String(retryAfter),
        });
    }
    if (url.pathname === '/connect' && request.method === 'GET') {
      if (!(await verifyOAuthQueryParams(url.searchParams.toString(), this.secret)))
        return json({ error: 'invalid_request' }, 400);
      if (this.active.size >= 16) return json({ error: 'temporarily_unavailable' }, 429);
      const clientId = url.searchParams.get('client_id') ?? '';
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      if (
        !allowedRedirect(redirectUri) ||
        url.searchParams.getAll('resource').length !== 1 ||
        url.searchParams.get('resource') !== this.resource
      )
        return json({ error: 'invalid_target' }, 400);
      const client = await (
        await this.auth!.$context
      ).adapter.findOne({ model: 'oauthClient', where: [{ field: 'clientId', value: clientId }] });
      if (!client) return json({ error: 'invalid_client' }, 400);
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.signal.addEventListener('abort', abort, { once: true });
      if (request.signal.aborted) abort();
      const deadline = setTimeout(abort, 300_000);
      this.active.add(controller);
      try {
        await this.connectFidelity(controller.signal);
        controller.signal.throwIfAborted();
        // Fidelity credentials stay in Chrome. This is a separate local MCP
        // grant, automatically issued once the native extension proves readiness.
        const refreshGrant = (url.searchParams.get('scope') ?? '')
          .split(' ')
          .includes('offline_access');
        const sessionResponse = await this.auth!.handler(
          new Request(`${this.origin}/auth/local-owner-session`, {
            method: 'POST',
            body: JSON.stringify({ refreshGrant }),
            headers: { Origin: this.origin, 'Content-Type': 'application/json' },
          }),
        );
        if (!sessionResponse.ok) throw new Error('Local session could not complete.');
        const cookie = sessionResponse.headers
          .getSetCookie()
          .map((value) => value.split(';')[0])
          .join('; ');
        const consentResponse = await this.auth!.handler(
          new Request(`${this.origin}/auth/oauth2/consent`, {
            method: 'POST',
            body: JSON.stringify({ accept: true, oauth_query: url.searchParams.toString() }),
            headers: { Cookie: cookie, Origin: this.origin, 'Content-Type': 'application/json' },
          }),
        );
        if (!consentResponse.ok) throw new Error('Connection could not complete.');
        const result = z.object({ url: z.string().url() }).parse(await consentResponse.json());
        controller.signal.throwIfAborted();
        const redirect = new URL(result.url),
          expected = new URL(redirectUri);
        if (
          redirect.origin !== expected.origin ||
          redirect.pathname !== expected.pathname ||
          !redirect.searchParams.has('code')
        )
          throw new Error('Unexpected callback.');
        return new Response(null, {
          status: 302,
          headers: { ...noStore, Location: redirect.href },
        });
      } catch {
        const redirect = new URL(redirectUri);
        redirect.searchParams.set('error', 'temporarily_unavailable');
        redirect.searchParams.set(
          'error_description',
          'Fidelity connection did not complete. Check Chrome and reconnect your agent.',
        );
        redirect.searchParams.set('iss', this.origin);
        if (url.searchParams.has('state'))
          redirect.searchParams.set('state', url.searchParams.get('state')!);
        return new Response(null, {
          status: 302,
          headers: { ...noStore, Location: redirect.href },
        });
      } finally {
        clearTimeout(deadline);
        request.signal.removeEventListener('abort', abort);
        this.active.delete(controller);
      }
    }
    const publicPaths = [
      '/auth/oauth2/authorize',
      '/auth/oauth2/register',
      '/auth/oauth2/token',
      '/auth/oauth2/revoke',
      '/auth/jwks',
    ];
    const discovery = [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-authorization-server',
      '/auth/.well-known/oauth-authorization-server',
    ];
    if (!publicPaths.includes(url.pathname) && !discovery.includes(url.pathname)) return undefined;
    let registrationBody: string | undefined;
    if (url.pathname === '/auth/oauth2/register' && request.method === 'POST') {
      const data = parseJsonObject(await request.clone().text());
      if (
        !Array.isArray(data.redirect_uris) ||
        !data.redirect_uris.length ||
        data.redirect_uris.length > 8 ||
        !data.redirect_uris.every((value) => typeof value === 'string' && allowedRedirect(value)) ||
        (data.token_endpoint_auth_method !== undefined &&
          data.token_endpoint_auth_method !== 'none') ||
        (typeof data.client_name === 'string' && data.client_name.length > 100)
      )
        return json({ error: 'invalid_client_metadata' }, 400);
      const count = this.database!.prepare('SELECT COUNT(*) AS count FROM oauthClient').get() as {
        count: number;
      };
      if (count.count >= 128) return json({ error: 'temporarily_unavailable' }, 429);
      // Desktop MCP clients commonly omit OIDC's application_type. These
      // public PKCE clients need native validation for their loopback callbacks.
      registrationBody = JSON.stringify({
        ...data,
        application_type: data.application_type ?? 'native',
      });
    }
    const headers = new Headers(request.headers);
    // No public HTTP path can carry or obtain the local owner's session.
    headers.delete('cookie');
    if (url.pathname === '/auth/oauth2/authorize') headers.delete('authorization');
    const response = await this.auth!.handler(
      new Request(request, {
        headers,
        ...(registrationBody === undefined ? {} : { body: registrationBody }),
      }),
    );
    response.headers.delete('set-cookie');
    return response;
  }
  private recordRequest(path: string): number | undefined {
    const limit = rateLimitedRoutes[path]!.limit;
    const now = Date.now();
    const database = this.database!;
    database.exec('BEGIN IMMEDIATE');
    try {
      const cutoff = now - rateLimitWindowMs;
      database.prepare('DELETE FROM localOAuthRateLimit WHERE requestedAt <= ?').run(cutoff);
      const usage = database
        .prepare(
          'SELECT COUNT(*) AS count, MIN(requestedAt) AS oldest FROM localOAuthRateLimit WHERE route = ? AND requestedAt > ?',
        )
        .get(path, cutoff) as { count: number; oldest: number | null };
      let retryAfter: number | undefined;
      if (usage.count >= limit && usage.oldest !== null) {
        retryAfter = Math.max(1, Math.ceil((usage.oldest + rateLimitWindowMs - now) / 1000));
      } else {
        database
          .prepare('INSERT INTO localOAuthRateLimit (route, requestedAt) VALUES (?, ?)')
          .run(path, now);
      }
      database.exec('COMMIT');
      return retryAfter;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
  close(): void {
    for (const controller of this.active) controller.abort();
    this.active.clear();
    this.database?.close();
  }
}

export function revokeLocalAccess(base: string): void {
  const database = new DatabaseSync(join(base, 'auth.sqlite'));
  try {
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare('DELETE FROM oauthConsent').run();
      database.prepare('DELETE FROM oauthAccessToken').run();
      database.prepare('DELETE FROM oauthRefreshToken').run();
      database.prepare('DELETE FROM verification').run();
      database.prepare('DELETE FROM session').run();
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  } finally {
    database.close();
  }
}
