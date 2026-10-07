/**
 * Streamable HTTP transport, for a cloud deployment reachable from claude.ai
 * web, mobile and desktop.
 *
 * Two authentication modes, both tenant-aware:
 *   - Secret link (self-host / testers): a long random secret (CONTI_TOKEN),
 *     accepted as `Authorization: Bearer <token>` or in the `/mcp/<token>`
 *     path. All of it is the single `default` tenant.
 *   - OAuth (hosted, for the connector directory): the server is an OAuth 2.0
 *     Resource Server. It publishes discovery metadata, validates the bearer
 *     access token issued by an external Authorization Server, and maps the
 *     token's subject to its own tenant — one address, every user isolated,
 *     no secret to paste.
 */
import express from 'express';
import { createMcpExpressApp, requireBearerAuth, mcpAuthMetadataRouter } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, getOAuthProtectedResourceMetadataUrl, type OAuthMetadata, type OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { timingSafeEqual } from 'node:crypto';
import type { Store } from '../store/store.js';
import { createServer, VERSION } from './server.js';
import { tenantOf } from './oauth.js';
import { RACCOON_BADGE_SVG } from '../core/brand.js';

/** OAuth Resource Server runtime, built at startup from the Authorization Server's metadata. */
export interface OAuthRuntime {
  /** Verifies incoming access tokens and stamps the tenant onto AuthInfo. */
  verifier: OAuthTokenVerifier;
  /** Authorization Server metadata (OIDC / RFC 8414), served to clients for discovery. */
  metadata: OAuthMetadata;
  /** This MCP server's public resource URL, e.g. https://conti.example.com/mcp. */
  resourceServerUrl: URL;
  /** Scopes advertised in the Protected Resource Metadata. */
  scopesSupported?: string[];
}

export interface HttpOptions {
  store: Store;
  host: string;
  port: number;
  token: string | null;
  allowedHosts?: string[];
  /** Origin hostnames allowed for browser requests (DNS-rebinding / CSRF protection). */
  allowedOrigins?: string[];
  /** When set, the `/mcp` endpoint requires an OAuth bearer token and data is isolated per user. */
  oauth?: OAuthRuntime;
}

const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function startHttp(o: HttpOptions) {
  const app = createMcpExpressApp({ host: o.host, allowedHosts: o.allowedHosts, allowedOrigins: o.allowedOrigins, jsonLimit: '4mb' });
  app.set('trust proxy', true);

  // One MCP server instance per request, scoped to the request's tenant: the
  // OAuth subject (hosted) or the default tenant (secret link / self-host).
  const handler = createMcpHandler((ctx) => createServer({ store: o.store.forTenant(tenantOf(ctx.authInfo)) }));
  const node = toNodeHandler(handler);

  app.get('/health', async (_req, res) => {
    res.json({ ok: true, name: 'conti-mcp', version: VERSION, auth: o.oauth ? 'oauth' : o.token ? 'token' : 'none', revision: await o.store.revision() });
  });
  app.get('/', (_req, res) => {
    res.type('text/plain').send('Conti MCP server. Endpoint: /mcp' + (o.oauth ? ' (OAuth)' : o.token ? '/<token> or /mcp with Authorization: Bearer <token>' : ''));
  });

  // Serve the raccoon mark at the connector's domain, so hosts that pick the
  // icon from the URL's favicon get the raccoon, not the deploy platform's.
  const sendIcon = (res: express.Response) => res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(RACCOON_BADGE_SVG);
  app.get(['/favicon.svg', '/favicon.ico', '/icon.svg'], (_req, res) => sendIcon(res));

  const forward = async (req: express.Request, res: express.Response) => {
    try {
      await node(req, res, req.body);
    } catch (e) {
      console.error('[conti] request failed', e);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  };

  // Secret-link path (self-host / testers): the `default` tenant, no OAuth.
  const secretAuthorized = (req: express.Request) => {
    if (!o.token) return true;
    const p = req.params as Record<string, string | undefined>;
    if (p.token && safeEq(p.token, o.token)) return true;
    const h = req.headers.authorization ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    return !!m && safeEq(m[1]!.trim(), o.token);
  };
  const secretRoute = async (req: express.Request, res: express.Response) => {
    if (!secretAuthorized(req)) {
      res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
      return;
    }
    await forward(req, res);
  };

  if (o.oauth) {
    // Publish the OAuth discovery documents so unauthenticated clients can find
    // the Authorization Server from the 401 challenge, then log in.
    app.use(
      mcpAuthMetadataRouter({
        oauthMetadata: o.oauth.metadata,
        resourceServerUrl: o.oauth.resourceServerUrl,
        scopesSupported: o.oauth.scopesSupported,
        resourceName: 'Conti',
      }),
    );
    const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(o.oauth.resourceServerUrl);
    const gate = requireBearerAuth({ verifier: o.oauth.verifier, resourceMetadataUrl });
    // Bare /mcp: OAuth bearer required; the middleware sets req.auth → tenant.
    app.all('/mcp', gate, forward);
    // The secret-link path stays available for self-host / testers (default tenant).
    app.all('/mcp/:token', secretRoute);
  } else {
    app.all('/mcp', secretRoute);
    app.all('/mcp/:token', secretRoute);
  }

  return new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const srv = app.listen(o.port, o.host, () => {
      const mode = o.oauth ? 'OAuth' : o.token ? 'token required' : 'open';
      console.error(`[conti] HTTP MCP server on http://${o.host}:${o.port}/mcp (${mode})`);
      resolve(srv);
    });
  });
}
