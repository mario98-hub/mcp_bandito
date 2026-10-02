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

async function withClient(db, fn) {
  const c = await stdioClient(db);
  try {
    return await fn(c);
  } finally {
    await c.close();
  }
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

test('stdio: v0.2 onboarding, goals, purchase budget and modules', async () => {
  const c = await stdioClient(join(dir, 'c.db'));
  try {
    const tools = (await c.listTools()).tools.map((t) => t.name);
    for (const n of ['conti_onboarding', 'conti_set_goal', 'conti_delete_goal', 'conti_purchase_budget'])
      assert.ok(tools.includes(n), n);

    // onboarding starts at step 1 and is not onboarded
    let r = await c.callTool({ name: 'conti_onboarding', arguments: {} });
    assert.equal(r.structuredContent.next.id, 'who');
    assert.equal(r.structuredContent.onboarded, false);

    await c.callTool({
      name: 'conti_setup',
      arguments: { name: 'Casa V2', locale: 'it', members: [{ name: 'Mara' }], accounts: [{ name: 'Conto', kind: 'cash', owners: [{ member: 'Mara', share: 1 }] }] },
    });

    // next step is the goal, with localized options
    r = await c.callTool({ name: 'conti_onboarding', arguments: {} });
    assert.equal(r.structuredContent.next.id, 'goal');
    assert.ok(r.structuredContent.options.some((o) => o.key === 'home' && o.label));

    // set a primary home goal with a target
    r = await c.callTool({ name: 'conti_set_goal', arguments: { kind: 'home', targetAmount: 60000, primary: true } });
    assert.ok(!r.isError, text(r));
    assert.equal(r.structuredContent.goal.primary, true);
    const goalId = r.structuredContent.goal.id;

    await c.callTool({ name: 'conti_record_month', arguments: { month: '2026-01', balances: [{ account: 'Conto', balance: 20000 }], incomes: [{ member: 'Mara', net: 3000 }] } });
    await c.callTool({ name: 'conti_record_month', arguments: { month: '2026-02', balances: [{ account: 'Conto', balance: 21000 }], incomes: [{ member: 'Mara', net: 3000 }] } });

    // overview reports the goal and resolved modules
    r = await c.callTool({ name: 'conti_get_overview', arguments: {} });
    assert.match(text(r), /Obiettivi/);
    assert.equal(r.structuredContent.goals.length, 1);
    assert.ok(r.structuredContent.goals[0].progress);
    assert.equal(r.structuredContent.modules.home, true); // auto-on from the home goal

    r = await c.callTool({ name: 'conti_onboarding', arguments: {} });
    assert.equal(r.structuredContent.onboarded, true);
    assert.equal(r.structuredContent.complete, true);

    // purchase budget: cash keeps the emergency fund; financing adds the largest affordable loan
    r = await c.callTool({ name: 'conti_purchase_budget', arguments: { rate: 0.06, years: 5, monthlyRunningCost: 100 } });
    assert.ok(!r.isError, text(r));
    assert.equal(r.structuredContent.tab, 'purchase');
    assert.ok(r.structuredContent.result.maxCash >= 0);
    assert.ok(r.structuredContent.result.maxFinanced > r.structuredContent.result.maxCash);

    // settings: force a module on and configure the reminder
    r = await c.callTool({ name: 'conti_update_settings', arguments: { modules: { invest: 'on' }, reminder: { day: 5, channel: 'task' } } });
    assert.ok(!r.isError, text(r));
    assert.equal(r.structuredContent.settings.modules.invest, 'on');
    assert.equal(r.structuredContent.settings.modules.home, 'auto'); // other modules untouched
    assert.equal(r.structuredContent.settings.reminder.day, 5);
    r = await c.callTool({ name: 'conti_get_overview', arguments: {} });
    assert.equal(r.structuredContent.modules.invest, true);

    // delete the goal
    r = await c.callTool({ name: 'conti_delete_goal', arguments: { goal: goalId } });
    assert.ok(!r.isError, text(r));
    r = await c.callTool({ name: 'conti_get_overview', arguments: {} });
    assert.equal(r.structuredContent.goals.length, 0);
  } finally {
    await c.close();
  }
});

test('stdio: goal edge cases, primary switching and backup round-trip', async () => {
  const c = await stdioClient(join(dir, 'd.db'));
  try {
    await c.callTool({
      name: 'conti_setup',
      arguments: { name: 'Edge', locale: 'en', members: [{ name: 'Rob' }], accounts: [{ name: 'Main', kind: 'cash', owners: [{ member: 'Rob', share: 1 }] }] },
    });

    // onboarding options are localized to English here
    let r = await c.callTool({ name: 'conti_onboarding', arguments: {} });
    assert.equal(r.structuredContent.next.id, 'goal');
    const home = r.structuredContent.options.find((o) => o.key === 'home');
    assert.equal(home.label, 'Buy a home');

    // first goal is primary by default
    r = await c.callTool({ name: 'conti_set_goal', arguments: { kind: 'emergency' } });
    assert.equal(r.structuredContent.goal.primary, true);
    const g1 = r.structuredContent.goal.id;

    // a second goal set primary demotes the first
    r = await c.callTool({ name: 'conti_set_goal', arguments: { kind: 'home', primary: true, name: 'House' } });
    assert.equal(r.structuredContent.goal.primary, true);
    r = await c.callTool({ name: 'conti_get_overview', arguments: {} });
    const g1now = r.structuredContent.goals.find((g) => g.id === g1);
    assert.equal(g1now.primary, false);
    assert.equal(r.structuredContent.goals.filter((g) => g.primary).length, 1);

    // linking an unknown account fails cleanly, nothing saved
    r = await c.callTool({ name: 'conti_set_goal', arguments: { kind: 'invest', accounts: ['Nope'] } });
    assert.ok(r.isError);
    assert.match(text(r), /Unknown account/);

    // deleting a missing goal fails cleanly
    r = await c.callTool({ name: 'conti_delete_goal', arguments: { goal: 'does-not-exist' } });
    assert.ok(r.isError);

    // delete a goal by kind
    r = await c.callTool({ name: 'conti_delete_goal', arguments: { goal: 'emergency' } });
    assert.ok(!r.isError, text(r));

    // export carries goals; import restores them
    r = await c.callTool({ name: 'conti_export', arguments: {} });
    const backup = text(r);
    const parsed = JSON.parse(backup);
    assert.equal(parsed.state.goals.length, 1);
    assert.equal(parsed.state.goals[0].name, 'House');
    r = await c.callTool({ name: 'conti_import', arguments: { json: backup, confirm: true } });
    assert.ok(!r.isError, text(r));
    r = await c.callTool({ name: 'conti_get_overview', arguments: {} });
    assert.equal(r.structuredContent.goals.length, 1);
    assert.equal(r.structuredContent.goals[0].name, 'House');
  } finally {
    await c.close();
  }
});

test('stdio: three-person household with shared accounts, debt and goals', async () => {
  const c = await stdioClient(join(dir, 'multi.db'));
  try {
    let r = await c.callTool({
      name: 'conti_setup',
      arguments: {
        name: 'Famiglia Tre',
        locale: 'it',
        members: [{ name: 'Anna' }, { name: 'Bruno' }, { name: 'Carla' }],
        accounts: [
          { name: 'Conto Anna', kind: 'cash', owners: [{ member: 'Anna', share: 1 }] },
          { name: 'Broker Bruno', kind: 'investment', owners: [{ member: 'Bruno', share: 1 }] },
          { name: 'Conto Carla', kind: 'cash', owners: [{ member: 'Carla', share: 1 }] },
          { name: 'Conto comune', kind: 'cash', owners: [] },
          { name: 'Mutuo', kind: 'debt', owners: [{ member: 'Anna', share: 0.5 }, { member: 'Bruno', share: 0.5 }] },
        ],
      },
    });
    assert.ok(!r.isError, text(r));
    const ids = r.structuredContent.members.map((m) => m.id);
    assert.equal(ids.length, 3);

    // a shared primary goal and one linked to a personal account
    await c.callTool({ name: 'conti_set_goal', arguments: { kind: 'home', primary: true, targetAmount: 100000 } });
    await c.callTool({ name: 'conti_set_goal', arguments: { kind: 'emergency', accounts: ['Conto Carla'], targetAmount: 12000 } });

    for (const [month, mult] of [['2026-01', 1], ['2026-02', 2]]) {
      r = await c.callTool({
        name: 'conti_record_month',
        arguments: {
          month,
          balances: [
            { account: 'Conto Anna', balance: 10000 + 500 * mult },
            { account: 'Broker Bruno', balance: 20000 + 800 * mult, unrealizedGain: 1000 },
            { account: 'Conto Carla', balance: 8000 + 400 * mult },
            { account: 'Conto comune', balance: 6000 + 300 * mult, allocations: [{ member: 'Anna', amount: 1000 }, { member: 'Bruno', amount: 1000 }] },
            { account: 'Mutuo', balance: 150000 - 1000 * mult },
          ],
          incomes: [{ member: 'Anna', net: 2200 }, { member: 'Bruno', net: 2600 }, { member: 'Carla', net: 1900 }],
        },
      });
      assert.ok(!r.isError, text(r));
    }

    // overview: three owners + shared, negative debt, both goals, per-member flows
    r = await c.callTool({ name: 'conti_get_overview', arguments: {} });
    const ov = r.structuredContent;
    assert.equal(ov.members.length, 3);
    assert.ok(ov.netWorth.debts < 0, 'debt should be negative');
    assert.ok(ov.netWorth.byOwner._shared, 'joint remainder is shared');
    for (const id of ids) assert.ok(ov.flows.perMember[id], `flows for ${id}`);
    assert.equal(ov.goals.length, 2);
    assert.equal(ov.goals.filter((g) => g.primary).length, 1);

    // history has every owner column and both months
    r = await c.callTool({ name: 'conti_get_history', arguments: {} });
    assert.match(text(r), /Anna/);
    assert.match(text(r), /2026-01/);
    assert.match(text(r), /2026-02/);

    // home scenario with a different capital share per member
    r = await c.callTool({
      name: 'conti_home_scenario',
      arguments: { name: 'Casa', price: 300000, rate: 0.03, closingCosts: 10000, capitalUse: [{ member: 'Anna', share: 0.6 }, { member: 'Bruno', share: 0.5 }, { member: 'Carla', share: 0.7 }], save: true },
    });
    assert.ok(!r.isError, text(r));
    assert.equal(r.structuredContent.result.perOwner.filter((o) => o.liquid > 0).length >= 3, true);

    // household purchase budget
    r = await c.callTool({ name: 'conti_purchase_budget', arguments: { rate: 0.06, years: 6 } });
    assert.ok(!r.isError, text(r));
    assert.ok(r.structuredContent.result.maxFinanced > r.structuredContent.result.maxCash);
  } finally {
    await c.close();
  }
});

test('stdio: concurrent clients write one database safely', async () => {
  const db = join(dir, 'concurrent.db');
  await withClient(db, (c) =>
    c.callTool({
      name: 'conti_setup',
      arguments: { name: 'Shared', locale: 'en', members: [{ name: 'Uno' }], accounts: [{ name: 'Acc', kind: 'cash', owners: [{ member: 'Uno', share: 1 }] }] },
    }),
  );

  // four independent client processes record different months at the same time
  const months = ['2026-01', '2026-02', '2026-03', '2026-04'];
  const results = await Promise.all(
    months.map((m, i) =>
      withClient(db, (c) =>
        c.callTool({ name: 'conti_record_month', arguments: { month: m, balances: [{ account: 'Acc', balance: 1000 + i * 100 }], incomes: [{ member: 'Uno', net: 2000 }] } }),
      ),
    ),
  );
  for (const r of results) assert.ok(!r.isError, text(r));

  // every write landed, no lost update
  await withClient(db, async (c) => {
    const hist = await c.callTool({ name: 'conti_get_history', arguments: {} });
    for (const m of months) assert.match(text(hist), new RegExp(m));
    const ov = await c.callTool({ name: 'conti_get_overview', arguments: {} });
    assert.equal(ov.structuredContent.latestMonth, '2026-04');
  });
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
