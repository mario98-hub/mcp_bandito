import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Store } from '../dist/store/store.js';
import { createClient } from '@libsql/client';
import { createServer as createHttpServer } from 'node:http';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';

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
    for (const n of ['conti_setup', 'conti_record_month', 'conti_dashboard', 'conti_home_scenario', 'conti_save_home_scenario', 'conti_simulate_purchase', 'conti_health_check'])
      assert.ok(tools.includes(n), n);
    const list = (await c.listTools()).tools;
    const dash = list.find((t) => t.name === 'conti_dashboard');
    assert.equal(dash._meta.ui.resourceUri, 'ui://conti/dashboard.html');
    // Analysis tools are text-only: they must NOT carry a UI resource, so hosts
    // run them without an "open app" confirmation and the model activates them directly.
    for (const n of ['conti_simulate_purchase', 'conti_purchase_budget', 'conti_home_scenario']) {
      const tool = list.find((t) => t.name === n);
      assert.ok(tool, n);
      assert.ok(!tool._meta?.ui, `${n} must not open the UI`);
    }

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
    r = await c.callTool({ name: 'conti_save_home_scenario', arguments: { name: 'Bilocale', price: 250000, rate: 0.03, closingCosts: 8000 } });
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

test('stdio: automatic snapshots, conti_undo and conti_delete_all', async () => {
  const c = await stdioClient(join(dir, 'undo.db'));
  try {
    const tools = (await c.listTools()).tools.map((t) => t.name);
    for (const n of ['conti_undo', 'conti_delete_all']) assert.ok(tools.includes(n), n);

    // nothing to undo on a fresh database
    let r = await c.callTool({ name: 'conti_undo', arguments: {} });
    assert.ok(r.isError);
    assert.match(text(r), /Nothing to undo/);

    await c.callTool({
      name: 'conti_setup',
      arguments: { name: 'Undo', locale: 'en', members: [{ name: 'Ann' }], accounts: [{ name: 'Bank', kind: 'cash', owners: [{ member: 'Ann', share: 1 }] }] },
    });
    await c.callTool({ name: 'conti_set_goal', arguments: { kind: 'emergency', name: 'Buffer' } });

    // a delete is snapshotted: undo restores the goal
    r = await c.callTool({ name: 'conti_delete_goal', arguments: { goal: 'Buffer' } });
    assert.ok(!r.isError, text(r));
    r = await c.callTool({ name: 'conti_get_overview', arguments: {} });
    assert.equal(r.structuredContent.goals.length, 0);

    r = await c.callTool({ name: 'conti_undo', arguments: {} });
    assert.ok(!r.isError, text(r));
    assert.match(text(r), /goal\.delete/);
    r = await c.callTool({ name: 'conti_get_overview', arguments: {} });
    assert.equal(r.structuredContent.goals.length, 1);
    assert.equal(r.structuredContent.goals[0].name, 'Buffer');

    // conti_delete_all wipes everything, but undo brings it back
    r = await c.callTool({ name: 'conti_delete_all', arguments: { confirm: true } });
    assert.ok(!r.isError, text(r));
    r = await c.callTool({ name: 'conti_get_overview', arguments: {} });
    assert.equal(r.structuredContent.setUp, false);

    r = await c.callTool({ name: 'conti_undo', arguments: {} });
    assert.ok(!r.isError, text(r));
    r = await c.callTool({ name: 'conti_get_overview', arguments: {} });
    assert.equal(r.structuredContent.setUp, true);
    assert.equal(r.structuredContent.members.length, 1);
    assert.equal(r.structuredContent.goals.length, 1);

    // an import overwrite is snapshotted too
    const exp = JSON.parse(text(await c.callTool({ name: 'conti_export', arguments: {} })));
    const blank = { format: 'conti-mcp', state: { ...exp.state, household: null, members: [], accounts: [], goals: [], snapshots: [], incomes: [], budget: [], scenarios: [] } };
    r = await c.callTool({ name: 'conti_import', arguments: { json: JSON.stringify(blank), confirm: true } });
    assert.ok(!r.isError, text(r));
    r = await c.callTool({ name: 'conti_get_overview', arguments: {} });
    assert.equal(r.structuredContent.setUp, false);
    r = await c.callTool({ name: 'conti_undo', arguments: {} });
    assert.ok(!r.isError, text(r));
    r = await c.callTool({ name: 'conti_get_overview', arguments: {} });
    assert.equal(r.structuredContent.setUp, true);
    assert.equal(r.structuredContent.members.length, 1);
  } finally {
    await c.close();
  }
});

test('store: snapshots are capped and restore pops the stack', async () => {
  const store = await Store.open({ url: `file:${join(dir, 'prune.db')}` });
  try {
    await store.setHousehold({ name: 'Cap', currency: 'EUR', locale: 'en', createdAt: new Date().toISOString() });
    await store.upsertMember({ id: 'ann', name: 'Ann' });
    // 12 destructive ops, but the undo stack is capped at 10
    for (let i = 0; i < 12; i++) await store.deleteGoal(`missing-${i}`);
    assert.equal((await store.listBackups()).length, 10);

    // restore pops the newest snapshot and reports how many are left
    const r = await store.restore();
    assert.ok(r);
    assert.equal(r.action, 'goal.delete');
    assert.equal(r.remaining, 9);
    assert.equal((await store.listBackups()).length, 9);
    assert.equal((await store.load()).household.name, 'Cap');
  } finally {
    store.close();
  }
});

test('store: tenants are isolated end to end', async () => {
  const root = await Store.open({ url: `file:${join(dir, 'multi-tenant.db')}` });
  try {
    const a = root.forTenant('user-a');
    const b = root.forTenant('user-b');
    await a.setHousehold({ name: 'A-home', currency: 'EUR', locale: 'en', createdAt: new Date().toISOString() });
    await a.upsertMember({ id: 'ann', name: 'Ann' });
    await b.setHousehold({ name: 'B-home', currency: 'USD', locale: 'en', createdAt: new Date().toISOString() });
    await b.upsertMember({ id: 'bob', name: 'Bob' });

    assert.equal((await a.load()).household.name, 'A-home');
    assert.equal((await b.load()).household.name, 'B-home');
    assert.deepEqual((await a.load()).members.map((m) => m.id), ['ann']);
    assert.deepEqual((await b.load()).members.map((m) => m.id), ['bob']);
    // the default tenant (self-host / secret link) sees neither
    assert.equal((await root.load()).household, null);

    // wiping tenant A leaves tenant B untouched; undo stacks are per-tenant
    await a.deleteAll();
    assert.equal((await a.load()).household, null);
    assert.equal((await b.load()).household.name, 'B-home');
    const r = await a.restore();
    assert.ok(r);
    assert.equal((await a.load()).household.name, 'A-home');
    assert.equal((await b.listBackups()).length, 0);
  } finally {
    root.close();
  }
});

test('store: migrates a pre-tenant database to the default tenant', async () => {
  const url = `file:${join(dir, 'legacy-schema.db')}`;
  // Seed the OLD, pre-tenant schema by hand (no tenant column, no backups table).
  const raw = createClient({ url });
  await raw.executeMultiple(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE docs (collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (collection, id));
    CREATE TABLE changelog (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, action TEXT NOT NULL, detail TEXT);
  `);
  await raw.execute({ sql: 'INSERT INTO meta(key,value) VALUES(?,?)', args: ['household', JSON.stringify({ name: 'Legacy', currency: 'EUR', locale: 'en', createdAt: '2020-01-01T00:00:00.000Z' })] });
  await raw.execute({ sql: 'INSERT INTO docs(collection,id,data,updated_at) VALUES(?,?,?,?)', args: ['members', 'leo', JSON.stringify({ id: 'leo', name: 'Leo' }), '2020-01-01T00:00:00.000Z'] });
  raw.close();

  // Opening migrates in place: old rows become the default tenant, writes keep working.
  const store = await Store.open({ url });
  try {
    const st = await store.load();
    assert.equal(st.household.name, 'Legacy');
    assert.deepEqual(st.members.map((m) => m.id), ['leo']);
    assert.equal((await store.forTenant('someone-else').load()).household, null);
    await store.upsertMember({ id: 'mia', name: 'Mia' });
    assert.equal((await store.load()).members.length, 2);
  } finally {
    store.close();
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

    // home scenario (read-only simulation) with a different capital share per member
    r = await c.callTool({
      name: 'conti_home_scenario',
      arguments: { name: 'Casa', price: 300000, rate: 0.03, closingCosts: 10000, capitalUse: [{ member: 'Anna', share: 0.6 }, { member: 'Bruno', share: 0.5 }, { member: 'Carla', share: 0.7 }] },
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

    // the raccoon mark is served at the domain (so hosts don't fall back to the deploy platform's favicon)
    const fav = await fetch(`http://127.0.0.1:${port}/favicon.svg`);
    assert.ok((fav.headers.get('content-type') ?? '').startsWith('image/svg+xml'));
    assert.match(await fav.text(), /<svg[\s\S]*#f5c84c/);

    for (const [url, opts] of [
      [`http://127.0.0.1:${port}/mcp/${token}`, {}],
      [`http://127.0.0.1:${port}/mcp`, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }],
    ]) {
      const c = new Client({ name: 'test', version: '1.0.0' });
      await c.connect(new StreamableHTTPClientTransport(new URL(url), opts));
      // the server advertises the raccoon icon + website as its MCP identity
      const info = c.getServerVersion();
      assert.equal(info.name, 'conti');
      assert.ok(info.icons?.length, 'server advertises icons');
      assert.match(info.icons[0].src, /^data:image\/svg\+xml,/);
      assert.ok(info.websiteUrl, 'server advertises websiteUrl');
      const r = await c.callTool({ name: 'conti_get_overview', arguments: {} });
      assert.match(text(r), /Alex & Sam/);
      await c.close();
    }
  } finally {
    p.kill();
  }
});

// A throwaway OAuth Authorization Server (OIDC discovery + JWKS) for one test.
async function startFakeIdp() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'idp-key', alg: 'RS256', use: 'sig' };
  let issuer = '';
  const server = createHttpServer((req, res) => {
    if (req.url === '/.well-known/openid-configuration') {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          issuer,
          jwks_uri: `${issuer}/jwks`,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          registration_endpoint: `${issuer}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        }),
      );
    } else if (req.url === '/jwks') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ keys: [jwk] }));
    } else {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      issuer = `http://127.0.0.1:${server.address().port}`;
      resolve({ server, issuer, privateKey });
    });
  });
}

function mintToken(privateKey, issuer, audience, sub) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const header = b64({ alg: 'RS256', kid: 'idp-key', typ: 'JWT' });
  const now = Math.floor(Date.now() / 1000);
  const payload = b64({ iss: issuer, aud: audience, sub, iat: now, exp: now + 3600, scope: 'openid' });
  const sig = cryptoSign('sha256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
  return `${header}.${payload}.${sig}`;
}

test('http: OAuth mode — discovery, 401 challenge, per-user isolation, secret path intact', async () => {
  const idp = await startFakeIdp();
  const port = 39600 + Math.floor(Math.random() * 300);
  const publicUrl = `http://127.0.0.1:${port}`;
  const audience = `${publicUrl}/mcp`;
  const secret = 'secret-token-0123456789abcdefghij';
  const p = spawn(process.execPath, ['dist/cli.js', '--http', '--port', String(port), '--host', '127.0.0.1', '--db', join(dir, 'oauth.db')], {
    env: { ...process.env, CONTI_OAUTH_ISSUER: idp.issuer, CONTI_PUBLIC_URL: publicUrl, CONTI_OAUTH_AUDIENCE: audience, CONTI_TOKEN: secret },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  await new Promise((res, rej) => {
    p.stderr.on('data', (d) => String(d).includes('HTTP MCP server') && res());
    p.on('exit', (code) => rej(new Error('server exited ' + code)));
    setTimeout(() => rej(new Error('timeout')), 8000);
  });
  const bearer = (sub) => ({ requestInit: { headers: { Authorization: `Bearer ${mintToken(idp.privateKey, idp.issuer, audience, sub)}` } } });
  try {
    // Discovery documents are published and point back at the Authorization Server.
    const prm = await fetch(`${publicUrl}/.well-known/oauth-protected-resource/mcp`).then((r) => r.json());
    assert.ok(String(prm.resource).includes('/mcp'), 'PRM advertises the resource');
    assert.ok(JSON.stringify(prm).includes(idp.issuer), 'PRM points at the Authorization Server');
    const asm = await fetch(`${publicUrl}/.well-known/oauth-authorization-server`).then((r) => r.json());
    assert.ok(JSON.stringify(asm).includes(idp.issuer), 'AS metadata passthrough');

    // Unauthenticated → 401 with a pointer to the discovery document.
    const denied = await fetch(`${publicUrl}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get('www-authenticate') ?? '', /resource_metadata=/);

    // Alice logs in and sets up her household.
    const alice = new Client({ name: 'test', version: '1.0.0' });
    await alice.connect(new StreamableHTTPClientTransport(new URL(`${publicUrl}/mcp`), bearer('alice')));
    await alice.callTool({ name: 'conti_setup', arguments: { name: 'Alice-home', members: [{ name: 'Alice' }] } });
    let r = await alice.callTool({ name: 'conti_get_overview', arguments: {} });
    assert.match(text(r), /Alice-home/);
    await alice.close();

    // Bob logs in and sees none of Alice's data.
    const bob = new Client({ name: 'test', version: '1.0.0' });
    await bob.connect(new StreamableHTTPClientTransport(new URL(`${publicUrl}/mcp`), bearer('bob')));
    r = await bob.callTool({ name: 'conti_get_overview', arguments: {} });
    assert.equal(r.structuredContent.setUp, false);
    await bob.close();

    // The secret-link path still works and is its own (default) tenant.
    const self = new Client({ name: 'test', version: '1.0.0' });
    await self.connect(new StreamableHTTPClientTransport(new URL(`${publicUrl}/mcp/${secret}`)));
    r = await self.callTool({ name: 'conti_get_overview', arguments: {} });
    assert.equal(r.structuredContent.setUp, false);
    await self.close();
  } finally {
    p.kill();
    idp.server.close();
  }
});
