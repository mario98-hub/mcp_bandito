import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const dir = mkdtempSync(join(tmpdir(), 'conti-'));
const text = (r) => r.content.map((c) => c.text).join('\n');
after(() => rmSync(dir, { recursive: true, force: true }));

async function stdioClient(db) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/cli.js', '--db', db], stderr: 'pipe' }));
  return client;
}

test('stdio: full monthly workflow', async () => {
  const c = await stdioClient(join(dir, 'a.db'));
  try {
    const tools = (await c.listTools()).tools.map((t) => t.name);
    for (const n of ['conti_setup', 'conti_record_month', 'conti_dashboard', 'conti_home_scenario', 'conti_simulate_purchase', 'conti_health_check'])
      assert.ok(tools.includes(n), n);
    const dash = (await c.listTools()).tools.find((t) => t.name === 'conti_dashboard');
    assert.equal(dash._meta.ui.resourceUri, 'ui://conti/dashboard.html');

    let r = await c.callTool({ name: 'conti_get_overview', arguments: {} });
    assert.match(text(r), /not set up/);

    r = await c.callTool({
      name: 'conti_setup',
      arguments: {
        name: 'Casa Test',
        locale: 'it',
        members: [{ name: 'Giulia' }, { name: 'Luca' }],
        accounts: [
          { name: 'Fineco', kind: 'investment', owners: [{ member: 'Giulia', share: 1 }] },
          { name: 'BBVA', kind: 'cash', owners: [{ member: 'luca' }] },
          { name: 'Conto comune', kind: 'cash', owners: [] },
          { name: 'Prestito auto', kind: 'debt', owners: [{ member: 'Giulia', share: 0.5 }, { member: 'Luca', share: 0.5 }] },
        ],
      },
    });
    assert.ok(!r.isError, text(r));
    assert.match(text(r), /fineco/);

    r = await c.callTool({
      name: 'conti_record_month',
      arguments: {
        month: '2026-08',
        balances: [
          { account: 'Fineco', balance: 30000, unrealizedGain: 2000 },
          { account: 'bbva', balance: 8000 },
          { account: 'Conto comune', balance: 3000 },
          { account: 'Prestito auto', balance: 5000 },
        ],
        incomes: [{ member: 'Giulia', net: 2500 }, { member: 'Luca', net: 2100 }],
      },
    });
    assert.ok(!r.isError, text(r));
    assert.match(text(r), /completo|complete/);

    r = await c.callTool({ name: 'conti_record_month', arguments: { month: '2026-09', balances: [{ account: 'Fineco', balance: 31200, unrealizedGain: 2300 }], incomes: [{ member: 'Giulia', net: 2500, extra: 400 }] } });
    assert.match(text(r), /Still missing/);
    assert.equal(r.structuredContent.status.overall, 'partial');

    r = await c.callTool({ name: 'conti_record_month', arguments: { month: '2026-09', balances: [{ account: 'Nonexistent', balance: 1 }] } });
    assert.ok(r.isError);

    r = await c.callTool({ name: 'conti_get_overview', arguments: {} });
    assert.match(text(r), /Patrimonio/);
    assert.equal(r.structuredContent.netWorth.debts, -5000);

    r = await c.callTool({ name: 'conti_upsert_budget_item', arguments: { name: 'Affitto', amount: 1100 } });
    assert.ok(!r.isError, text(r));
    r = await c.callTool({ name: 'conti_simulate_purchase', arguments: { name: 'Divano', price: 1500 } });
    assert.match(text(r), /Divano/);
    r = await c.callTool({ name: 'conti_home_scenario', arguments: { name: 'Bilocale', price: 250000, rate: 0.03, closingCosts: 8000, save: true } });
    assert.ok(!r.isError, text(r));
    assert.equal(r.structuredContent.tab, 'home');

    r = await c.callTool({ name: 'conti_app_state', arguments: {} });
    const view = r.structuredContent.view;
    assert.equal(view.state.members.length, 2);
    assert.equal(view.home.length, 1);
    assert.equal(view.computed.latestMonth, '2026-09');

    const res = await c.readResource({ uri: 'ui://conti/dashboard.html' });
    assert.equal(res.contents[0].mimeType, 'text/html;profile=mcp-app');
    assert.match(res.contents[0].text, /<html/);

    r = await c.callTool({ name: 'conti_export', arguments: {} });
    const backup = text(r);
    assert.match(backup, /"format": "conti-mcp"/);
    r = await c.callTool({ name: 'conti_import', arguments: { json: backup, confirm: true } });
    assert.ok(!r.isError, text(r));
  } finally {
    await c.close();
  }
});

test('http: token required, works with bearer and secret path', async () => {
  const token = 'test-token-0123456789abcdefghij';
  const port = 39000 + Math.floor(Math.random() * 500);
  const p = spawn(process.execPath, ['dist/cli.js', '--http', '--port', String(port), '--db', join(dir, 'b.db'), '--demo'], {
    env: { ...process.env, CONTI_TOKEN: token },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  await new Promise((res, rej) => {
    p.stderr.on('data', (d) => String(d).includes('HTTP MCP server') && res());
    p.on('exit', (code) => rej(new Error('exited ' + code)));
    setTimeout(() => rej(new Error('timeout')), 8000);
  });
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
    assert.equal(health.ok, true);
    const denied = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(denied.status, 401);

    for (const [url, opts] of [
      [`http://127.0.0.1:${port}/mcp/${token}`, {}],
      [`http://127.0.0.1:${port}/mcp`, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }],
    ]) {
      const c = new Client({ name: 'test', version: '1.0.0' });
      await c.connect(new StreamableHTTPClientTransport(new URL(url), opts));
      const r = await c.callTool({ name: 'conti_get_overview', arguments: {} });
      assert.match(text(r), /Alex & Sam/);
      await c.close();
    }
  } finally {
    p.kill();
  }
});
