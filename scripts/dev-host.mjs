// Local preview: `npm run preview` → http://localhost:5174
// Starts the built server over stdio (demo data in .dev/conti.db) and a tiny
// MCP Apps host page that renders the dashboard and logs what Claude would receive.
import express from 'express';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const port = Number(process.env.PREVIEW_PORT ?? 5174);
const db = process.env.CONTI_DB ?? '.dev/conti.db';
const client = new Client({ name: 'conti-dev-host', version: '0.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/cli.js', '--db', db, '--demo'], stderr: 'inherit' }));

const js = (await build({ entryPoints: ['scripts/dev-host/host.ts'], bundle: true, format: 'esm', write: false, platform: 'browser' })).outputFiles[0].text;
const app = express();
app.use(express.json({ limit: '4mb' }));
app.get('/', (_q, r) => r.type('html').send(`<!doctype html><meta charset="utf-8"><title>Conti dev host</title>
<style>body{margin:0;font:14px system-ui;display:grid;grid-template-columns:minmax(0,760px) 1fr;gap:16px;background:#ddd}
iframe{width:100%;border:0;height:900px;background:#fff;display:block}#log{padding:12px;font:12px ui-monospace,monospace;overflow:auto;height:100vh}.ev{padding:4px 0;border-bottom:1px solid #ccc;white-space:pre-wrap}.message{color:#0a5}</style>
<iframe id="app" sandbox="allow-scripts allow-forms allow-popups allow-modals"></iframe><div id="log"></div><script type="module">${js}</script>`));
app.get('/api/ui', async (_q, r) => {
  const res = await client.readResource({ uri: 'ui://conti/dashboard.html' });
  r.json({ html: res.contents[0].text });
});
app.post('/api/tool', async (q, r) => {
  try { r.json(await client.callTool({ name: q.body.name, arguments: q.body.arguments })); }
  catch (e) { r.json({ isError: true, content: [{ type: 'text', text: String(e.message ?? e) }] }); }
});
app.listen(port, '127.0.0.1', () => console.error(`Conti dev host: http://localhost:${port}`));
