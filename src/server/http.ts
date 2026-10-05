/**
 * Streamable HTTP transport, for a personal cloud deployment reachable from
 * claude.ai web, mobile and desktop.
 *
 * Auth: a long random secret (CONTI_TOKEN). Accepted as
 *   - Authorization: Bearer <token>   (Claude Desktop config, Claude Code, other clients)
 *   - /mcp/<token> path               (claude.ai custom connectors, which take a URL)
 */
import express from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { timingSafeEqual } from 'node:crypto';
import type { Store } from '../store/store.js';
import { createServer, VERSION } from './server.js';

export interface HttpOptions {
  store: Store;
  host: string;
  port: number;
  token: string | null;
  allowedHosts?: string[];
}

const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function startHttp(o: HttpOptions) {
  const app = createMcpExpressApp({ host: o.host, allowedHosts: o.allowedHosts, jsonLimit: '4mb' });
  app.set('trust proxy', true);
  const handler = createMcpHandler(() => createServer({ store: o.store }));
  const node = toNodeHandler(handler);

  app.get('/health', async (_req, res) => {
    res.json({ ok: true, name: 'conti-mcp', version: VERSION, revision: await o.store.revision() });
  });
  app.get('/', (_req, res) => {
    res.type('text/plain').send('Conti MCP server. Endpoint: /mcp' + (o.token ? '/<token> or /mcp with Authorization: Bearer <token>' : ''));
  });

  const authorized = (req: express.Request) => {
    if (!o.token) return true;
    const p = req.params as Record<string, string | undefined>;
    if (p.token && safeEq(p.token, o.token)) return true;
    const h = req.headers.authorization ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    return !!m && safeEq(m[1]!.trim(), o.token);
  };

  const route = async (req: express.Request, res: express.Response) => {
    if (!authorized(req)) {
      res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
      return;
    }
    try {
      await node(req, res, req.body);
    } catch (e) {
      console.error('[conti] request failed', e);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  };
  app.all('/mcp', route);
  app.all('/mcp/:token', route);

  return new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const srv = app.listen(o.port, o.host, () => {
      console.error(`[conti] HTTP MCP server on http://${o.host}:${o.port}/mcp${o.token ? ' (token required)' : ''}`);
      resolve(srv);
    });
  });
}
