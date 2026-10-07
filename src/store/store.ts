/**
 * libSQL persistence (@libsql/client), one code path for a local file and for
 * a remote Turso database — selected by the connection URL:
 *   - file:/data/conti.db        local SQLite file (dev, stdio, home server)
 *   - libsql://<db>.turso.io      Turso cloud, with an auth token
 *
 * Multi-tenant: every row carries a `tenant` column and a Store instance is
 * bound to one tenant. One database holds every household, isolated by tenant,
 * so the same connection serves a self-hosted single household (tenant
 * `default`) and a hosted deployment where each OAuth user gets their own
 * tenant. `forTenant(id)` returns a lightweight view that shares the connection
 * and the single-writer queue. The data set of one household is tiny (a few
 * thousand rows after decades), so the store loads a tenant's documents in full
 * on each read.
 */
import { createClient, type Client, type Transaction } from '@libsql/client';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_SETTINGS,
  emptyState,
  type Account,
  type BudgetItem,
  type Goal,
  type HomeScenario,
  type Household,
  type Income,
  type Member,
  type Settings,
  type Snapshot,
  type State,
} from '../core/types.js';

type Collection = 'members' | 'accounts' | 'snapshots' | 'incomes' | 'budget' | 'scenarios' | 'goals';
const COLLECTIONS: Collection[] = ['members', 'accounts', 'snapshots', 'incomes', 'budget', 'scenarios', 'goals'];

/** The tenant used for self-hosting / the secret-link path, and for migrated pre-tenant databases. */
export const DEFAULT_TENANT = 'default';

/** Anything we can run a statement against: the connection or an open transaction. */
type Exec = Pick<Client, 'execute'> | Transaction;

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
export const slug = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32) || 'x';

export interface StoreConfig {
  /** libSQL URL: `file:/path/conti.db` or `libsql://<db>.turso.io`. */
  url: string;
  /** Auth token, required for remote (libsql://) databases. */
  authToken?: string;
}

export class Store {
  readonly client: Client;
  /** Full-state snapshots kept per tenant as an undo stack; older ones are pruned. */
  private static readonly MAX_BACKUPS = 10;

  /**
   * Shared single-writer queue. One object is shared by a root store and all of
   * its `forTenant` views, so writes across every tenant serialize on one
   * logical connection (libSQL allows a single writer at a time).
   */
  private readonly q: { p: Promise<unknown> };

  private constructor(client: Client, readonly url: string, readonly tenant: string, q: { p: Promise<unknown> }) {
    this.client = client;
    this.q = q;
  }

  /** Open a store (bound to the default tenant) and ensure the schema exists. */
  static async open(config: StoreConfig): Promise<Store> {
    // libSQL does not create the parent directory of a local file; make sure it exists.
    if (config.url.startsWith('file:')) {
      try {
        const p = new URL(config.url).pathname;
        if (p) mkdirSync(dirname(p), { recursive: true });
      } catch {
        /* unparseable file: URL — let createClient surface the error */
      }
    }
    const client = createClient({ url: config.url, authToken: config.authToken });
    const store = new Store(client, config.url, DEFAULT_TENANT, { p: Promise.resolve() });
    await store.migrate();
    return store;
  }

  /** A view of this store scoped to `tenant`, sharing the connection and the write queue. Never `close()` a view. */
  forTenant(tenant: string): Store {
    const t = tenant && tenant.trim() ? tenant.trim() : DEFAULT_TENANT;
    return t === this.tenant ? this : new Store(this.client, this.url, t, this.q);
  }

  private async tableExists(table: string): Promise<boolean> {
    const rs = await this.client.execute({ sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", args: [table] });
    return rs.rows.length > 0;
  }
  private async columnExists(table: string, col: string): Promise<boolean> {
    try {
      const rs = await this.client.execute({ sql: `PRAGMA table_info(${table})` });
      return rs.rows.some((r) => r.name === col);
    } catch {
      return false;
    }
  }

  private async migrate() {
    // WAL/busy_timeout only mean something for a local file; Turso manages concurrency itself.
    if (this.url.startsWith('file:')) {
      await this.client.executeMultiple('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    }
    // Upgrade a pre-tenant database in place: rebuild meta/docs to add the tenant
    // to the primary key (ALTER cannot change a PK), and add the column to the
    // append-only logs. Existing rows become the `default` tenant.
    if ((await this.tableExists('meta')) && !(await this.columnExists('meta', 'tenant'))) {
      await this.client.executeMultiple(`
        CREATE TABLE meta_new (tenant TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (tenant, key));
        INSERT INTO meta_new (tenant, key, value) SELECT '${DEFAULT_TENANT}', key, value FROM meta;
        DROP TABLE meta;
        ALTER TABLE meta_new RENAME TO meta;
      `);
    }
    if ((await this.tableExists('docs')) && !(await this.columnExists('docs', 'tenant'))) {
      await this.client.executeMultiple(`
        CREATE TABLE docs_new (tenant TEXT NOT NULL, collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (tenant, collection, id));
        INSERT INTO docs_new (tenant, collection, id, data, updated_at) SELECT '${DEFAULT_TENANT}', collection, id, data, updated_at FROM docs;
        DROP TABLE docs;
        ALTER TABLE docs_new RENAME TO docs;
      `);
    }
    for (const tbl of ['changelog', 'backups']) {
      if ((await this.tableExists(tbl)) && !(await this.columnExists(tbl, 'tenant'))) {
        await this.client.execute(`ALTER TABLE ${tbl} ADD COLUMN tenant TEXT NOT NULL DEFAULT '${DEFAULT_TENANT}'`);
      }
    }
    // Fresh, tenant-aware schema for new databases.
    await this.client.executeMultiple(`
      CREATE TABLE IF NOT EXISTS meta (tenant TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (tenant, key));
      CREATE TABLE IF NOT EXISTS docs (
        tenant TEXT NOT NULL,
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant, collection, id)
      );
      CREATE TABLE IF NOT EXISTS changelog (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant TEXT NOT NULL DEFAULT '${DEFAULT_TENANT}',
        at TEXT NOT NULL,
        action TEXT NOT NULL,
        detail TEXT
      );
      CREATE TABLE IF NOT EXISTS backups (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant TEXT NOT NULL DEFAULT '${DEFAULT_TENANT}',
        at TEXT NOT NULL,
        action TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_backups_tenant ON backups(tenant, seq);
    `);
  }

  close() {
    this.client.close();
  }

  // ------------------------------------------------------------ read

  private async meta<T>(key: string, ex: Exec = this.client): Promise<T | null> {
    const rs = await ex.execute({ sql: 'SELECT value FROM meta WHERE tenant = ? AND key = ?', args: [this.tenant, key] });
    const row = rs.rows[0];
    return row ? (JSON.parse(row.value as string) as T) : null;
  }

  async load(ex: Exec = this.client): Promise<State> {
    const s = emptyState();
    s.revision = (await this.meta<number>('revision', ex)) ?? 0;
    s.household = await this.meta<Household>('household', ex);
    s.settings = { ...DEFAULT_SETTINGS, ...((await this.meta<Partial<Settings>>('settings', ex)) ?? {}) };
    const rs = await ex.execute({ sql: 'SELECT collection, data FROM docs WHERE tenant = ? ORDER BY collection, id', args: [this.tenant] });
    for (const r of rs.rows) {
      const arr = s[r.collection as Collection] as unknown[] | undefined;
      if (Array.isArray(arr)) arr.push(JSON.parse(r.data as string));
    }
    // stable, meaningful ordering
    s.snapshots.sort((a, b) => a.month.localeCompare(b.month) || a.accountId.localeCompare(b.accountId));
    s.incomes.sort((a, b) => a.month.localeCompare(b.month) || a.memberId.localeCompare(b.memberId));
    const order = ((await this.meta<Record<string, string[]>>('order', ex)) ?? {}) as Record<string, string[]>;
    for (const c of ['members', 'accounts', 'budget', 'scenarios', 'goals'] as const) {
      const o = order[c];
      if (o) (s[c] as { id: string }[]).sort((a, b) => idx(o, a.id) - idx(o, b.id));
    }
    return s;
  }

  async revision(): Promise<number> {
    return (await this.meta<number>('revision')) ?? 0;
  }

  async changelog(limit = 20) {
    const rs = await this.client.execute({ sql: 'SELECT at, action, detail FROM changelog WHERE tenant = ? ORDER BY seq DESC LIMIT ?', args: [this.tenant, limit] });
    return rs.rows;
  }

  // ------------------------------------------------------------ write helpers

  private async setMeta(ex: Exec, key: string, value: unknown) {
    await ex.execute({
      sql: 'INSERT INTO meta(tenant, key, value) VALUES(?, ?, ?) ON CONFLICT(tenant, key) DO UPDATE SET value = excluded.value',
      args: [this.tenant, key, JSON.stringify(value)],
    });
  }
  private async put(ex: Exec, c: Collection, id: string, data: unknown) {
    await ex.execute({
      sql: 'INSERT INTO docs(tenant, collection, id, data, updated_at) VALUES(?, ?, ?, ?, ?) ON CONFLICT(tenant, collection, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
      args: [this.tenant, c, id, JSON.stringify(data), new Date().toISOString()],
    });
    if (c === 'members' || c === 'accounts' || c === 'budget' || c === 'scenarios' || c === 'goals') {
      const order = (await this.meta<Record<string, string[]>>('order', ex)) ?? {};
      const o = (order[c] ??= []);
      if (!o.includes(id)) {
        o.push(id);
        await this.setMeta(ex, 'order', order);
      }
    }
  }
  private async del(ex: Exec, c: Collection, id: string) {
    const rs = await ex.execute({ sql: 'DELETE FROM docs WHERE tenant = ? AND collection = ? AND id = ?', args: [this.tenant, c, id] });
    return rs.rowsAffected > 0;
  }

  /** Capture the current full state as a restore point, then prune the stack. Call inside a destructive tx, before mutating. */
  private async backup(ex: Exec, action: string) {
    const st = await this.load(ex);
    await ex.execute({ sql: 'INSERT INTO backups(tenant, at, action, data) VALUES(?, ?, ?, ?)', args: [this.tenant, new Date().toISOString(), action, JSON.stringify(st)] });
    await ex.execute({
      sql: 'DELETE FROM backups WHERE tenant = ? AND seq NOT IN (SELECT seq FROM backups WHERE tenant = ? ORDER BY seq DESC LIMIT ?)',
      args: [this.tenant, this.tenant, Store.MAX_BACKUPS],
    });
  }

  /** Replace every document and the household/settings/order meta of this tenant with the given state. Does not snapshot or bump the revision — the caller's tx does. */
  private async _overwrite(ex: Exec, s: State) {
    await ex.execute({ sql: 'DELETE FROM docs WHERE tenant = ?', args: [this.tenant] });
    await ex.execute({ sql: "DELETE FROM meta WHERE tenant = ? AND key IN ('order','household','settings')", args: [this.tenant] });
    if (s.household) await this.setMeta(ex, 'household', s.household);
    await this.setMeta(ex, 'settings', { ...DEFAULT_SETTINGS, ...s.settings });
    for (const c of COLLECTIONS) {
      for (const d of (s[c] ?? []) as unknown as Record<string, string>[]) {
        const id = c === 'snapshots' ? `${d.accountId}|${d.month}` : c === 'incomes' ? `${d.memberId}|${d.month}` : d.id!;
        await this.put(ex, c, id, d);
      }
    }
  }

  /** Run a mutation atomically and bump this tenant's revision. Writes are serialized across all tenants. */
  tx<T>(action: string, detail: unknown, fn: (ex: Transaction) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const tx = await this.client.transaction('write');
      try {
        const out = await fn(tx);
        await this.setMeta(tx, 'revision', ((await this.meta<number>('revision', tx)) ?? 0) + 1);
        await tx.execute({
          sql: 'INSERT INTO changelog(tenant, at, action, detail) VALUES(?, ?, ?, ?)',
          args: [this.tenant, new Date().toISOString(), action, detail === undefined ? null : JSON.stringify(detail).slice(0, 2000)],
        });
        await tx.commit();
        return out;
      } catch (e) {
        try {
          await tx.rollback();
        } catch {
          /* already closed */
        }
        throw e;
      } finally {
        tx.close();
      }
    };
    const result = this.q.p.then(run, run);
    this.q.p = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  // ------------------------------------------------------------ mutations

  setHousehold(h: Household) {
    return this.tx('household', h, (ex) => this.setMeta(ex, 'household', h));
  }

  updateSettings(patch: Partial<Settings>) {
    return this.tx('settings', patch, async (ex) => {
      const cur = { ...DEFAULT_SETTINGS, ...((await this.meta<Partial<Settings>>('settings', ex)) ?? {}) };
      const next = { ...cur, ...patch };
      await this.setMeta(ex, 'settings', next);
      return next;
    });
  }

  upsertMember(m: Member) {
    return this.tx('member', m, (ex) => this.put(ex, 'members', m.id, m));
  }
  /** Removes a member, their incomes and their account shares. */
  removeMember(id: string) {
    return this.tx('member.remove', { id }, async (ex) => {
      await this.backup(ex, 'member.remove');
      const st = await this.load(ex);
      for (const i of st.incomes.filter((i) => i.memberId === id)) await this.del(ex, 'incomes', `${i.memberId}|${i.month}`);
      for (const a of st.accounts.filter((a) => a.owners.some((o) => o.memberId === id))) {
        await this.put(ex, 'accounts', a.id, { ...a, owners: a.owners.filter((o) => o.memberId !== id) });
      }
      for (const b of st.budget.filter((b) => b.ownerId === id)) await this.put(ex, 'budget', b.id, { ...b, ownerId: null });
      return this.del(ex, 'members', id);
    });
  }

  upsertAccount(a: Account) {
    return this.tx('account', a, (ex) => this.put(ex, 'accounts', a.id, a));
  }
  deleteAccount(id: string) {
    return this.tx('account.delete', { id }, async (ex) => {
      await this.backup(ex, 'account.delete');
      await ex.execute({ sql: "DELETE FROM docs WHERE tenant = ? AND collection = 'snapshots' AND id LIKE ?", args: [this.tenant, `${id}|%`] });
      return this.del(ex, 'accounts', id);
    });
  }

  recordMonth(snapshots: Snapshot[], incomes: Income[]) {
    const now = new Date().toISOString();
    return this.tx(
      'month',
      { snapshots: snapshots.length, incomes: incomes.length, months: [...new Set([...snapshots, ...incomes].map((x) => x.month))] },
      async (ex) => {
        for (const s of snapshots) await this.put(ex, 'snapshots', `${s.accountId}|${s.month}`, { ...s, updatedAt: now });
        for (const i of incomes) await this.put(ex, 'incomes', `${i.memberId}|${i.month}`, { ...i, updatedAt: now });
      },
    );
  }
  deleteEntries(month: string, accountIds: string[], memberIds: string[]) {
    return this.tx('month.delete', { month, accountIds, memberIds }, async (ex) => {
      await this.backup(ex, 'month.delete');
      let n = 0;
      for (const a of accountIds) n += Number(await this.del(ex, 'snapshots', `${a}|${month}`));
      for (const m of memberIds) n += Number(await this.del(ex, 'incomes', `${m}|${month}`));
      return n;
    });
  }

  upsertBudgetItem(b: BudgetItem) {
    return this.tx('budget', b, (ex) => this.put(ex, 'budget', b.id, b));
  }
  deleteBudgetItem(id: string) {
    return this.tx('budget.delete', { id }, async (ex) => {
      await this.backup(ex, 'budget.delete');
      return this.del(ex, 'budget', id);
    });
  }

  upsertScenario(s: HomeScenario) {
    return this.tx('scenario', s, (ex) => this.put(ex, 'scenarios', s.id, s));
  }
  deleteScenario(id: string) {
    return this.tx('scenario.delete', { id }, async (ex) => {
      await this.backup(ex, 'scenario.delete');
      return this.del(ex, 'scenarios', id);
    });
  }

  upsertGoal(g: Goal) {
    return this.tx('goal', g, (ex) => this.put(ex, 'goals', g.id, g));
  }
  deleteGoal(id: string) {
    return this.tx('goal.delete', { id }, async (ex) => {
      await this.backup(ex, 'goal.delete');
      return this.del(ex, 'goals', id);
    });
  }

  /** Replace everything with the given state (used by import). Snapshots the previous state first. */
  replaceAll(s: State) {
    return this.tx('import', { members: s.members.length, accounts: s.accounts.length, snapshots: s.snapshots.length }, async (ex) => {
      await this.backup(ex, 'import');
      await this._overwrite(ex, s);
    });
  }

  /** Erase all data of this tenant (members, accounts, months, budget, goals, scenarios, settings). Snapshots first. */
  deleteAll() {
    return this.tx('delete.all', {}, async (ex) => {
      await this.backup(ex, 'delete.all');
      await this._overwrite(ex, emptyState());
    });
  }

  /** Restore the latest snapshot (or a specific `seq`) and pop it off the stack. Returns null if there is nothing to restore. */
  restore(seq?: number): Promise<{ seq: number; at: string; action: string; remaining: number } | null> {
    return this.tx('restore', { seq: seq ?? null }, async (ex) => {
      const rs = seq
        ? await ex.execute({ sql: 'SELECT seq, at, action, data FROM backups WHERE tenant = ? AND seq = ?', args: [this.tenant, seq] })
        : await ex.execute({ sql: 'SELECT seq, at, action, data FROM backups WHERE tenant = ? ORDER BY seq DESC LIMIT 1', args: [this.tenant] });
      const row = rs.rows[0];
      if (!row) return null;
      await this._overwrite(ex, JSON.parse(row.data as string) as State);
      await ex.execute({ sql: 'DELETE FROM backups WHERE tenant = ? AND seq = ?', args: [this.tenant, row.seq as number] });
      const left = await ex.execute({ sql: 'SELECT COUNT(*) AS n FROM backups WHERE tenant = ?', args: [this.tenant] });
      return { seq: Number(row.seq), at: row.at as string, action: row.action as string, remaining: Number(left.rows[0]!.n) };
    });
  }

  /** The restore points currently available for this tenant, newest first. */
  async listBackups(limit = Store.MAX_BACKUPS) {
    const rs = await this.client.execute({ sql: 'SELECT seq, at, action FROM backups WHERE tenant = ? ORDER BY seq DESC LIMIT ?', args: [this.tenant, limit] });
    return rs.rows.map((r) => ({ seq: Number(r.seq), at: r.at as string, action: r.action as string }));
  }
}

function idx(o: string[], id: string) {
  const i = o.indexOf(id);
  return i < 0 ? 1e9 : i;
}
