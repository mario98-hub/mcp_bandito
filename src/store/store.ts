/**
 * SQLite persistence (node:sqlite, no native dependencies).
 *
 * The data set of a household is tiny (a few thousand rows after decades),
 * so the store is a simple document table loaded in full on each read.
 */
import { DatabaseSync } from 'node:sqlite';
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

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
export const slug = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32) || 'x';

export class Store {
  readonly db: DatabaseSync;

  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS docs (
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (collection, id)
      );
      CREATE TABLE IF NOT EXISTS changelog (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        action TEXT NOT NULL,
        detail TEXT
      );
    `);
  }

  close() {
    this.db.close();
  }

  // ------------------------------------------------------------ read

  private meta<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : null;
  }

  load(): State {
    const s = emptyState();
    s.revision = this.meta<number>('revision') ?? 0;
    s.household = this.meta<Household>('household');
    s.settings = { ...DEFAULT_SETTINGS, ...(this.meta<Partial<Settings>>('settings') ?? {}) };
    const rows = this.db.prepare('SELECT collection, data FROM docs ORDER BY collection, id').all() as {
      collection: Collection;
      data: string;
    }[];
    for (const r of rows) {
      const arr = s[r.collection] as unknown[] | undefined;
      if (Array.isArray(arr)) arr.push(JSON.parse(r.data));
    }
    // stable, meaningful ordering
    s.snapshots.sort((a, b) => a.month.localeCompare(b.month) || a.accountId.localeCompare(b.accountId));
    s.incomes.sort((a, b) => a.month.localeCompare(b.month) || a.memberId.localeCompare(b.memberId));
    const order = (this.meta<Record<string, string[]>>('order') ?? {}) as Record<string, string[]>;
    for (const c of ['members', 'accounts', 'budget', 'scenarios', 'goals'] as const) {
      const o = order[c];
      if (o) (s[c] as { id: string }[]).sort((a, b) => idx(o, a.id) - idx(o, b.id));
    }
    return s;
  }

  revision(): number {
    return this.meta<number>('revision') ?? 0;
  }

  changelog(limit = 20) {
    return this.db.prepare('SELECT at, action, detail FROM changelog ORDER BY seq DESC LIMIT ?').all(limit);
  }

  // ------------------------------------------------------------ write helpers

  private setMeta(key: string, value: unknown) {
    this.db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  }
  private put(c: Collection, id: string, data: unknown) {
    this.db
      .prepare('INSERT INTO docs(collection, id, data, updated_at) VALUES(?, ?, ?, ?) ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
      .run(c, id, JSON.stringify(data), new Date().toISOString());
    if (c === 'members' || c === 'accounts' || c === 'budget' || c === 'scenarios' || c === 'goals') {
      const order = this.meta<Record<string, string[]>>('order') ?? {};
      const o = (order[c] ??= []);
      if (!o.includes(id)) {
        o.push(id);
        this.setMeta('order', order);
      }
    }
  }
  private del(c: Collection, id: string) {
    return Number(this.db.prepare('DELETE FROM docs WHERE collection = ? AND id = ?').run(c, id).changes) > 0;
  }

  /** Run a mutation atomically and bump the revision. */
  tx<T>(action: string, detail: unknown, fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.setMeta('revision', this.revision() + 1);
      this.db
        .prepare('INSERT INTO changelog(at, action, detail) VALUES(?, ?, ?)')
        .run(new Date().toISOString(), action, detail === undefined ? null : JSON.stringify(detail).slice(0, 2000));
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ------------------------------------------------------------ mutations

  setHousehold(h: Household) {
    this.tx('household', h, () => this.setMeta('household', h));
  }

  updateSettings(patch: Partial<Settings>) {
    return this.tx('settings', patch, () => {
      const cur = { ...DEFAULT_SETTINGS, ...(this.meta<Partial<Settings>>('settings') ?? {}) };
      const next = { ...cur, ...patch };
      this.setMeta('settings', next);
      return next;
    });
  }

  upsertMember(m: Member) {
    this.tx('member', m, () => this.put('members', m.id, m));
  }
  /** Removes a member, their incomes and their account shares. */
  removeMember(id: string) {
    return this.tx('member.remove', { id }, () => {
      const st = this.load();
      for (const i of st.incomes.filter((i) => i.memberId === id)) this.del('incomes', `${i.memberId}|${i.month}`);
      for (const a of st.accounts.filter((a) => a.owners.some((o) => o.memberId === id))) {
        this.put('accounts', a.id, { ...a, owners: a.owners.filter((o) => o.memberId !== id) });
      }
      for (const b of st.budget.filter((b) => b.ownerId === id)) this.put('budget', b.id, { ...b, ownerId: null });
      return this.del('members', id);
    });
  }

  upsertAccount(a: Account) {
    this.tx('account', a, () => this.put('accounts', a.id, a));
  }
  deleteAccount(id: string) {
    return this.tx('account.delete', { id }, () => {
      this.db.prepare("DELETE FROM docs WHERE collection = 'snapshots' AND id LIKE ?").run(`${id}|%`);
      return this.del('accounts', id);
    });
  }

  recordMonth(snapshots: Snapshot[], incomes: Income[]) {
    const now = new Date().toISOString();
    this.tx('month', { snapshots: snapshots.length, incomes: incomes.length, months: [...new Set([...snapshots, ...incomes].map((x) => x.month))] }, () => {
      for (const s of snapshots) this.put('snapshots', `${s.accountId}|${s.month}`, { ...s, updatedAt: now });
      for (const i of incomes) this.put('incomes', `${i.memberId}|${i.month}`, { ...i, updatedAt: now });
    });
  }
  deleteEntries(month: string, accountIds: string[], memberIds: string[]) {
    return this.tx('month.delete', { month, accountIds, memberIds }, () => {
      let n = 0;
      for (const a of accountIds) n += Number(this.del('snapshots', `${a}|${month}`));
      for (const m of memberIds) n += Number(this.del('incomes', `${m}|${month}`));
      return n;
    });
  }

  upsertBudgetItem(b: BudgetItem) {
    this.tx('budget', b, () => this.put('budget', b.id, b));
  }
  deleteBudgetItem(id: string) {
    return this.tx('budget.delete', { id }, () => this.del('budget', id));
  }

  upsertScenario(s: HomeScenario) {
    this.tx('scenario', s, () => this.put('scenarios', s.id, s));
  }
  deleteScenario(id: string) {
    return this.tx('scenario.delete', { id }, () => this.del('scenarios', id));
  }

  upsertGoal(g: Goal) {
    this.tx('goal', g, () => this.put('goals', g.id, g));
  }
  deleteGoal(id: string) {
    return this.tx('goal.delete', { id }, () => this.del('goals', id));
  }

  /** Replace everything with the given state (used by import). */
  replaceAll(s: State) {
    this.tx('import', { members: s.members.length, accounts: s.accounts.length, snapshots: s.snapshots.length }, () => {
      this.db.exec('DELETE FROM docs');
      this.db.prepare("DELETE FROM meta WHERE key IN ('order','household','settings')").run();
      if (s.household) this.setMeta('household', s.household);
      this.setMeta('settings', { ...DEFAULT_SETTINGS, ...s.settings });
      for (const c of COLLECTIONS) {
        for (const d of (s[c] ?? []) as unknown as Record<string, string>[]) {
          const id =
            c === 'snapshots' ? `${d.accountId}|${d.month}` : c === 'incomes' ? `${d.memberId}|${d.month}` : d.id!;
          this.put(c, id, d);
        }
      }
    });
  }
}

function idx(o: string[], id: string) {
  const i = o.indexOf(id);
  return i < 0 ? 1e9 : i;
}
