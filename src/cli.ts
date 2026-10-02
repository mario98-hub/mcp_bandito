#!/usr/bin/env node
/**
 * conti-mcp
 *   (no args)            stdio server for Claude Desktop / Claude Code / any local MCP client
 *   --http               Streamable HTTP server (personal cloud / home server)
 *   --port <n>           HTTP port (default $PORT or 3333)
 *   --host <h>           bind address (default 127.0.0.1; 0.0.0.0 in containers)
 *   --db <path>          SQLite file (default $CONTI_DB or ~/.conti/conti.db)
 *   --demo               seed the database with fictional demo data if it is empty
 *   --new-token          print a random token for CONTI_TOKEN and exit
 */
// node:sqlite prints an ExperimentalWarning on Node 22; keep stderr clean.
const emit = process.emitWarning.bind(process);
process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
  const msg = typeof w === 'string' ? w : w?.message;
  if (msg && msg.includes('SQLite')) return;
  return (emit as (...a: unknown[]) => void)(w, ...rest);
}) as typeof process.emitWarning;

import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

async function main() {
  if (flag('help') || flag('h')) {
    console.log(`conti-mcp: household finance MCP App

Usage:
  npx conti-mcp                 stdio server (Claude Desktop, Claude Code…)
  npx conti-mcp --http          HTTP server for claude.ai web & mobile

Options:
  --db <path>       SQLite database (env CONTI_DB, default ~/.conti/conti.db)
  --port <n>        HTTP port (env PORT, default 3333)
  --host <addr>     HTTP bind address (env HOST, default 127.0.0.1)
  --demo            fill an empty database with fictional demo data
  --new-token       print a random secret for CONTI_TOKEN
Env:
  CONTI_TOKEN       required for --http on a non-local address
  CONTI_ALLOWED_HOSTS  comma-separated public hostnames (DNS-rebinding protection)`);
    return;
  }
  if (flag('new-token')) {
    console.log(randomBytes(24).toString('base64url'));
    return;
  }

  const { Store } = await import('./store/store.js');
  const dbPath = opt('db') ?? process.env.CONTI_DB ?? join(homedir(), '.conti', 'conti.db');
  const store = new Store(dbPath);

  if (flag('demo') && !store.load().household) {
    const { demoState } = await import('./core/demo.js');
    store.replaceAll(demoState());
    console.error('[conti] demo data loaded');
  }

  if (flag('http')) {
    const { startHttp } = await import('./server/http.js');
    const host = opt('host') ?? process.env.HOST ?? '127.0.0.1';
    const port = Number(opt('port') ?? process.env.PORT ?? 3333);
    const token = process.env.CONTI_TOKEN?.trim() || null;
    const local = ['127.0.0.1', 'localhost', '::1'].includes(host);
    if (!token && !local && !flag('insecure-no-auth')) {
      console.error('[conti] Refusing to listen on a public address without CONTI_TOKEN. Generate one with: npx conti-mcp --new-token');
      process.exit(1);
    }
    if (token && token.length < 24) {
      console.error('[conti] CONTI_TOKEN is too short (min 24 chars). Generate one with: npx conti-mcp --new-token');
      process.exit(1);
    }
    const allowedHosts = process.env.CONTI_ALLOWED_HOSTS?.split(',').map((s) => s.trim()).filter(Boolean);
    await startHttp({ store, host, port, token, allowedHosts });
    console.error(`[conti] database: ${dbPath}`);
  } else {
    const { serveStdio } = await import('@modelcontextprotocol/server/stdio');
    const { createServer } = await import('./server/server.js');
    serveStdio(() => createServer({ store }));
    console.error(`[conti] stdio server ready · database: ${dbPath}`);
  }
}

main().catch((e) => {
  console.error('[conti] fatal', e);
  process.exit(1);
});
