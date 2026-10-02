/**
 * The Conti MCP server: model-facing tools, app-only tools for the UI and the
 * `ui://` resource that hosts render inline (MCP Apps).
 */
import { McpServer } from '@modelcontextprotocol/server';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { Store, newId, slug } from '../store/store.js';
import {
  compute,
  goalProgress,
  isMonthKey,
  isNum,
  mk,
  onboardingNext,
  purchaseBudget,
  resolveModules,
  simulateHome,
  simulatePurchase,
  type Computed,
} from '../core/engine.js';
import { SHARED, type Account, type Goal, type HomeScenario, type Locale, type State } from '../core/types.js';
import { t, money, pct, num, monthLabel } from '../core/i18n.js';
import { fromLegacy, isLegacyBackup } from '../core/legacy.js';
import { buildView } from './view.js';

export const VERSION = '0.2.0';
export const UI_URI = 'ui://conti/dashboard.html';

const here = dirname(fileURLToPath(import.meta.url));
function loadUiHtml(): string {
  for (const p of [join(here, '../ui/index.html'), join(here, '../../dist/ui/index.html')]) {
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  return '<!doctype html><meta charset="utf-8"><p>UI not built. Run <code>npm run build</code>.</p>';
}

const INSTRUCTIONS = `Conti keeps a household's finances in order with one snapshot a month: account balances and each person's net income. Savings, spending, savings rate, net worth, emergency fund and purchase affordability are derived from those numbers.

How to help the user:
- First time (conti_get_overview says "not set up"): run the guided setup. Call conti_onboarding to get the next step, then work through it: who is in the household and their main goal (conti_setup, conti_set_goal), the accounts and the monthly income (conti_setup / conti_record_month), then show the first dashboard. Call conti_onboarding again after each step to get the next one; steps 6-7 (goal details, monthly reminder) are optional.
- Goals: the primary goal shapes the dashboard and the tone. Use conti_set_goal to create or update it and to set a target amount/date or link the accounts that count towards it. conti_get_overview reports each goal's progress and estimated date.
- Monthly routine: the user sends screenshots or numbers. Read every balance (and unrealized gain for investment accounts, if shown) and each person's net pay, then call conti_record_month. If a figure is ambiguous, ask before saving. After saving, mention what is still missing for that month.
- Questions about money ("can we afford…", "how much can we spend", "how are we doing", "how much do we save"): call conti_get_overview, conti_health_check, conti_simulate_purchase, conti_purchase_budget or conti_home_scenario and answer with the numbers. Explain the reasoning in plain words so the user learns, and say which assumptions matter. You are not a licensed advisor: give information and trade-offs, not orders.
- Show the dashboard (conti_dashboard) when a visual helps, e.g. after recording a month or when asked "show me".
Amounts are in the household currency. Debts are negative balances. Month keys are YYYY-MM.`;

// ----------------------------------------------------------------- helpers

const ok = (text: string, structured?: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text }],
  ...(structured ? { structuredContent: structured } : {}),
});
const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

function todayKey() {
  const d = new Date();
  return mk(d.getFullYear(), d.getMonth() + 1);
}

function findMember(st: State, ref: string) {
  const r = ref.trim().toLowerCase();
  return st.members.find((m) => m.id === ref) ?? st.members.find((m) => m.name.toLowerCase() === r) ?? st.members.find((m) => m.name.toLowerCase().startsWith(r));
}
function findAccount(st: State, ref: string) {
  const r = ref.trim().toLowerCase();
  const full = (a: Account) => `${a.institution ?? ''} ${a.name}`.trim().toLowerCase();
  return (
    st.accounts.find((a) => a.id === ref) ??
    st.accounts.find((a) => a.name.toLowerCase() === r || full(a) === r) ??
    st.accounts.filter((a) => full(a).includes(r) || r.includes(a.name.toLowerCase())).sort((a, b) => Number(!!a.archived) - Number(!!b.archived))[0]
  );
}
function uniqueId(base: string, taken: Set<string>) {
  let id = slug(base);
  let i = 2;
  while (taken.has(id) || id === SHARED) id = `${slug(base)}-${i++}`;
  return id;
}

const ownerName = (st: State, id: string, L: Locale) => (id === SHARED ? t(L).shared : st.members.find((m) => m.id === id)?.name ?? id);
const goalLabel = (g: Goal, L: Locale) => g.name ?? t(L).goals.kinds[g.kind];

function overviewText(st: State, c: Computed, L: Locale): string {
  const T = t(L);
  const cur = c.currency;
  if (!st.household || !st.members.length) return 'Conti is not set up yet. Call conti_onboarding for the next guided step: ask who is in the household and their main goal, then call conti_setup and conti_set_goal.';
  const lines: string[] = [];
  lines.push(`# ${st.household.name}`);
  if (!c.latestMonth) {
    lines.push(`Members: ${st.members.map((m) => m.name).join(', ')}. Accounts: ${st.accounts.map((a) => a.name).join(', ') || 'none'}. No month recorded yet.`);
    return lines.join('\n');
  }
  const nw = c.netWorth;
  lines.push(`${T.netWorth} (${monthLabel(nw.asOf!, L)}): ${money(nw.total.realizable, cur, L)} after tax · market value ${money(nw.total.gross, cur, L)} · liquid ${money(nw.liquid, cur, L)} · cash ${money(nw.cash, cur, L)}${nw.debts ? ` · debts ${money(nw.debts, cur, L)}` : ''}`);
  lines.push(
    'By owner: ' +
      Object.entries(nw.byOwner)
        .map(([o, a]) => `${ownerName(st, o, L)} ${money(a.realizable, cur, L)}`)
        .join(' · '),
  );
  const hh = c.flows.household;
  if (hh) {
    lines.push(
      `${c.flows.year} averages per month (${hh.months} months): income ${money(hh.avgIncome, cur, L)}, savings ${money(hh.avgSavings, cur, L)}, spending ${money(hh.avgSpending, cur, L)}, savings rate ${pct(hh.savingsRate, L)}.`,
    );
    for (const m of st.members) {
      const y = c.flows.perMember[m.id];
      if (y) lines.push(`- ${m.name}: income ${money(y.avgIncome, cur, L)}, savings ${money(y.avgSavings, cur, L)}, rate ${pct(y.savingsRate, L)}`);
    }
  }
  const s = c.statusOf(todayKey());
  const miss = [...s.missingAccounts.map((id) => st.accounts.find((a) => a.id === id)?.name ?? id), ...s.missingIncomes.map((id) => `${ownerName(st, id, L)} income`)];
  lines.push(`This month (${monthLabel(s.month, L)}): ${s.overall === 'ok' ? 'complete' : `missing ${miss.join(', ')}`}.`);
  lines.push(`Health: ${c.health.map((h) => `${T.health[h.id].name} ${fmtMetric(h.id, h.value, L)} (${T.hs[h.status]})`).join(' · ')}`);
  if (st.budget.length) lines.push(`Budget: fixed ${money(c.budget.fixedMonthlyEquivalent, cur, L)}/month incl. yearly items; planned savings ${money(c.budget.plannedSavings, cur, L)}/month.`);
  const activeGoals = st.goals.filter((g) => g.status !== 'archived');
  if (activeGoals.length) {
    lines.push(
      `${T.goals.title}: ` +
        activeGoals
          .map((g) => {
            const gp = goalProgress(st, c, g);
            const prog = isNum(gp.target)
              ? `${pct(gp.pct, L)} (${money(gp.accumulated, cur, L)}/${money(gp.target, cur, L)}${gp.etaDate ? `, ${monthLabel(gp.etaDate, L)}` : ''})`
              : money(gp.accumulated, cur, L);
            return `${g.primary ? '★ ' : ''}${goalLabel(g, L)} ${prog}`;
          })
          .join(' · '),
    );
  }
  return lines.join('\n');
}

function fmtMetric(id: string, v: number | null, L: Locale) {
  if (!isNum(v)) return '—';
  if (id === 'savingsRate' || id === 'fixedCosts' || id === 'debtRatio') return pct(v, L);
  if (id === 'freshness') return `${num(v, L, 0)}m`;
  return `${num(v, L, 1)} ${L === 'it' ? 'mesi' : 'months'}`;
}

// ----------------------------------------------------------------- schemas

const kindEnum = z.enum(['cash', 'investment', 'pension', 'property', 'debt', 'other']);
const goalKindEnum = z.enum(['spending', 'emergency', 'home', 'invest', 'debt', 'purchase']);
const moduleModeEnum = z.enum(['auto', 'on', 'off']);
const ownerSchema = z.object({
  member: z.string().describe('Member id or name'),
  share: z.number().min(0).max(1).default(1).describe('Fraction owned, 0..1'),
});
const accountInput = z.object({
  id: z.string().optional().describe('Existing account id to update. Omit to create (or to match by name).'),
  name: z.string().describe('Short name, e.g. "Fineco", "Joint account", "Pension fund"'),
  institution: z.string().optional(),
  kind: kindEnum.default('cash').describe('cash | investment | pension | property | debt | other'),
  owners: z.array(ownerSchema).default([]).describe('Owners with shares. Empty = shared by the whole household.'),
  liquid: z.boolean().optional().describe('Counts toward emergency fund and purchases. Defaults: true for cash/investment, false otherwise.'),
  archived: z.boolean().optional(),
  note: z.string().optional(),
});
const scenarioInput = {
  id: z.string().optional().describe('Scenario id to update; omit for a new one'),
  name: z.string().default('Home'),
  price: z.number().positive(),
  familyHelp: z.number().min(0).default(0),
  rate: z.number().min(0).max(0.25).default(0.035).describe('Annual mortgage rate (TAN) as a fraction, e.g. 0.032'),
  agencyFee: z.number().min(0).max(0.2).default(0).describe('Agency fee as fraction of price, e.g. 0.03'),
  agencyFeeVat: z.number().min(0).max(0.5).default(0.22),
  closingCosts: z.number().min(0).default(0).describe('Notary, taxes, appraisal…'),
  capitalUse: z.array(z.object({ member: z.string(), share: z.number().min(0).max(1) })).default([]).describe('Fraction of each member’s liquid wealth used for the purchase (default 1)'),
  sharedCapitalUse: z.number().min(0).max(1).default(1),
  durations: z.array(z.number().int().min(5).max(40)).default([20, 25, 30]),
  note: z.string().optional(),
};

// ----------------------------------------------------------------- server

export interface ServerOptions {
  store: Store;
}

export function createServer({ store }: ServerOptions): McpServer {
  const server = new McpServer({ name: 'conti', title: 'Conti', version: VERSION }, { instructions: INSTRUCTIONS });
  const load = () => {
    const st = store.load();
    const L: Locale = st.household?.locale ?? 'en';
    return { st, L, c: compute(st, { today: todayKey() }) };
  };

  // ---------------------------------------------------------- UI resource
  registerAppResource(server, 'Conti dashboard', UI_URI, { description: 'Interactive household finance dashboard' }, async () => ({
    contents: [
      {
        uri: UI_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: loadUiHtml(),
        _meta: {
          ui: {
            prefersBorder: false,
            csp: { resourceDomains: ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'] },
          },
        },
      },
    ],
  }));

  const tabEnum = z.enum(['overview', 'month', 'history', 'budget', 'home', 'purchase', 'settings']);

  registerAppTool(
    server,
    'conti_dashboard',
    {
      title: 'Open Conti dashboard',
      description: 'Show the interactive Conti dashboard (net worth, month status, history, budget, home and purchase simulations). Use when the user wants to see their finances or after recording data.',
      inputSchema: z.object({ tab: tabEnum.optional(), month: z.string().optional().describe('YYYY-MM to focus') }),
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: UI_URI } },
    },
    async ({ tab, month }) => {
      const { st, L, c } = load();
      return ok(overviewText(st, c, L), { tab: tab ?? 'overview', month: month ?? null, revision: st.revision });
    },
  );

  // ---------------------------------------------------------- app-only
  registerAppTool(
    server,
    'conti_app_state',
    {
      title: 'Dashboard data',
      description: 'Full view model for the dashboard UI.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: UI_URI, visibility: ['app'] } },
    },
    async () => {
      const { st } = load();
      return ok('ok', { view: buildView(st, todayKey()) as unknown as Record<string, unknown> });
    },
  );

  // ---------------------------------------------------------- read tools
  server.registerTool(
    'conti_get_overview',
    {
      title: 'Financial overview',
      description: 'Text summary of the household: net worth by owner, average income/savings/spending, savings rate, what is missing this month, health indicators and budget. Call this first to answer any question about the user’s finances.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const { st, L, c } = load();
      return ok(overviewText(st, c, L), {
        setUp: !!st.household,
        onboarding: onboardingNext(st),
        modules: resolveModules(st),
        members: st.members,
        accounts: st.accounts.map((a) => ({ id: a.id, name: a.name, kind: a.kind, owners: a.owners, liquid: a.liquid, archived: !!a.archived })),
        latestMonth: c.latestMonth,
        netWorth: c.netWorth,
        flows: { year: c.flows.year, household: c.flows.household, perMember: c.flows.perMember },
        goals: st.goals.filter((g) => g.status !== 'archived').map((g) => ({ ...g, progress: goalProgress(st, c, g) })),
        thisMonth: c.statusOf(todayKey()),
      });
    },
  );

  server.registerTool(
    'conti_get_history',
    {
      title: 'Monthly history',
      description: 'Month-by-month table (net worth, income, savings, spending) and yearly summaries. Use for trends and comparisons between years.',
      inputSchema: z.object({
        from: z.string().optional().describe('YYYY-MM'),
        to: z.string().optional().describe('YYYY-MM'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ from, to }) => {
      const { st, L, c } = load();
      const rows = c.rows.filter((r) => (!from || r.month >= from) && (!to || r.month <= to));
      const owners = c.owners.map((o) => o.id);
      const head = `| Month | Net worth | ${owners.map((o) => ownerName(st, o, L)).join(' | ')} | Income | Savings | Spending |`;
      const sep = '|' + ' --- |'.repeat(owners.length + 5);
      const body = rows.map(
        (r) =>
          `| ${r.month} | ${money(r.total.realizable, c.currency, L)} | ${owners.map((o) => money(r.byOwner[o]?.realizable, c.currency, L)).join(' | ')} | ${money(r.incomeTotal, c.currency, L)} | ${money(r.savings.total, c.currency, L, true)} | ${money(r.spending.total, c.currency, L)} |`,
      );
      const years = c.years
        .filter((y) => y.owner === 'total')
        .map((y) => `- ${y.year} (${y.months} months): income ${money(y.avgIncome, c.currency, L)}/m, savings ${money(y.avgSavings, c.currency, L)}/m, rate ${pct(y.savingsRate, L)}, saved ${money(y.totalSavings, c.currency, L)}`);
      return ok([head, sep, ...body, '', '## Years', ...years].join('\n'), {
        rows: rows.map(({ status, ...r }) => ({ ...r, complete: status.overall })),
        years: c.years,
      });
    },
  );

  server.registerTool(
    'conti_health_check',
    {
      title: 'Financial health check',
      description: 'Educational check-up: savings rate, emergency fund, fixed costs, debt ratio, idle cash, data freshness. Each metric comes with its target and why it matters. Use it to coach the user.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const { L, c } = load();
      const T = t(L);
      const lines = c.health.map((h) => {
        const H = T.health[h.id];
        return `- **${H.name}**: ${fmtMetric(h.id, h.value, L)} → ${T.hs[h.status]}. ${H.why}`;
      });
      return ok(`## ${T.health.title}\n${lines.join('\n')}`, { metrics: c.health, refYear: c.refYear });
    },
  );

  server.registerTool(
    'conti_onboarding',
    {
      title: 'Guided setup',
      description:
        'Return the next onboarding step for the household, derived from the data (there is no saved progress, so the user can stop and resume anywhere). Steps: 1 who is in the household, 2 the main goal, 3 the accounts, 4 the monthly income, 5 the first dashboard, 6 goal details (optional), 7 a monthly reminder (optional). For the goal step the available options are returned, already localized. Call it first for a new household and again after each step.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const { st, L } = load();
      const T = t(L);
      const o = onboardingNext(st);
      const options = o.next?.id === 'goal' ? o.nextOptions.map((k) => ({ key: k, label: T.goals.kinds[k as keyof typeof T.goals.kinds] })) : [];
      const done = o.steps.filter((s) => s.done).length;
      const lines = [`Setup ${done}/${o.steps.length} ${L === 'it' ? 'completato' : 'complete'}.`];
      if (o.next) {
        lines.push(`${L === 'it' ? 'Prossimo passo' : 'Next'} — ${o.next.n}. ${T.onboardingSteps[o.next.id]}${o.next.optional ? ` (${L === 'it' ? 'facoltativo' : 'optional'})` : ''}.`);
        if (options.length) lines.push(`${T.goals.title}: ${options.map((x) => `${x.label} (${x.key})`).join(', ')}`);
      } else {
        lines.push(L === 'it' ? 'Configurazione completa.' : 'Setup complete.');
      }
      return ok(lines.join('\n'), { ...o, options });
    },
  );

  // ---------------------------------------------------------- setup
  server.registerTool(
    'conti_setup',
    {
      title: 'Set up household',
      description: 'Create or update the household: name, currency, language, members and (optionally) accounts. Idempotent: members and accounts are matched by name.',
      inputSchema: z.object({
        name: z.string().optional().describe('Household name, e.g. "Casa Rossi"'),
        currency: z.string().length(3).optional().describe('ISO 4217, default EUR'),
        locale: z.enum(['en', 'it']).optional().describe('Language for summaries and the dashboard'),
        members: z.array(z.object({ name: z.string(), color: z.string().optional() })).default([]),
        accounts: z.array(accountInput).default([]),
      }),
      annotations: { idempotentHint: true },
    },
    async (args) => {
      let st = store.load();
      const h = st.household ?? { name: 'Household', currency: 'EUR', locale: 'en' as Locale, createdAt: new Date().toISOString() };
      store.setHousehold({
        ...h,
        name: args.name ?? h.name,
        currency: (args.currency ?? h.currency).toUpperCase(),
        locale: args.locale ?? h.locale,
      });
      const palette = ['#1f5fbf', '#e2553a', '#2c7a2f', '#8a4fbf', '#c78a00', '#0f8a8a'];
      for (const m of args.members) {
        st = store.load();
        const ex = findMember(st, m.name);
        if (ex) store.upsertMember({ ...ex, name: m.name, color: m.color ?? ex.color });
        else store.upsertMember({ id: uniqueId(m.name, new Set(st.members.map((x) => x.id))), name: m.name, color: m.color ?? palette[st.members.length % palette.length] });
      }
      const created: string[] = [];
      for (const a of args.accounts) {
        const r = upsertAccount(a);
        if ('error' in r) return fail(r.error);
        created.push(`${r.account.name} (${r.account.id})`);
      }
      const { st: s2, L, c } = load();
      return ok(
        `Saved. Members: ${s2.members.map((m) => `${m.name} (${m.id})`).join(', ') || 'none'}. Accounts: ${s2.accounts.map((a) => `${a.name} (${a.id}, ${a.kind}, ${a.owners.length ? a.owners.map((o) => `${ownerName(s2, o.memberId, L)} ${pct(o.share, L)}`).join('+') : t(L).shared})`).join(', ') || 'none'}.\n\n${overviewText(s2, c, L)}`,
        { members: s2.members, accounts: s2.accounts },
      );
    },
  );

  function upsertAccount(a: z.infer<typeof accountInput>): { account: Account } | { error: string } {
    const st = store.load();
    const owners = [];
    for (const o of a.owners) {
      const m = findMember(st, o.member);
      if (!m) return { error: `Unknown member "${o.member}". Members: ${st.members.map((x) => x.name).join(', ') || 'none (call conti_setup first)'}.` };
      owners.push({ memberId: m.id, share: o.share });
    }
    const total = owners.reduce((s, o) => s + o.share, 0);
    if (total > 1.0001) return { error: `Owner shares add up to ${total}; they must be ≤ 1 (the remainder is household-shared).` };
    const ex = a.id ? st.accounts.find((x) => x.id === a.id) : st.accounts.find((x) => x.name.toLowerCase() === a.name.toLowerCase() && (x.institution ?? '') === (a.institution ?? x.institution ?? ''));
    if (a.id && !ex) return { error: `No account with id "${a.id}".` };
    const kind = a.kind;
    const acc: Account = {
      id: ex?.id ?? uniqueId(a.institution && !a.name.toLowerCase().includes(a.institution.toLowerCase()) ? `${a.institution}-${a.name}` : a.name, new Set(st.accounts.map((x) => x.id))),
      name: a.name,
      institution: a.institution ?? ex?.institution,
      kind,
      owners,
      liquid: a.liquid ?? (ex && ex.kind === kind ? ex.liquid : kind === 'cash' || kind === 'investment'),
      archived: a.archived ?? ex?.archived,
      note: a.note ?? ex?.note,
    };
    store.upsertAccount(acc);
    return { account: acc };
  }

  server.registerTool(
    'conti_upsert_account',
    {
      title: 'Add or update an account',
      description: 'Create or update one account (bank, broker, pension fund, property, loan). Owners are members with shares; no owners = shared by the household.',
      inputSchema: accountInput,
    },
    async (a) => {
      const r = upsertAccount(a);
      if ('error' in r) return fail(r.error);
      return ok(`Account saved: ${r.account.name} (id ${r.account.id}).`, { account: r.account });
    },
  );

  server.registerTool(
    'conti_delete_account',
    {
      title: 'Delete an account',
      description: 'Permanently delete an account and all its monthly balances. Prefer archiving (conti_upsert_account with archived: true) for closed accounts, so history stays intact. Only call after the user explicitly confirms.',
      inputSchema: z.object({ account: z.string().describe('Account id or name'), confirm: z.literal(true) }),
      annotations: { destructiveHint: true },
    },
    async ({ account }) => {
      const st = store.load();
      const a = findAccount(st, account);
      if (!a) return fail(`No account matches "${account}".`);
      store.deleteAccount(a.id);
      return ok(`Deleted ${a.name} and its history.`);
    },
  );

  server.registerTool(
    'conti_remove_member',
    {
      title: 'Remove a member',
      description: 'Remove a person from the household, with their incomes; their account shares become household-shared. Only after explicit confirmation.',
      inputSchema: z.object({ member: z.string(), confirm: z.literal(true) }),
      annotations: { destructiveHint: true },
    },
    async ({ member }) => {
      const st = store.load();
      const m = findMember(st, member);
      if (!m) return fail(`No member matches "${member}".`);
      store.removeMember(m.id);
      return ok(`Removed ${m.name}.`);
    },
  );

  // ---------------------------------------------------------- monthly data
  server.registerTool(
    'conti_record_month',
    {
      title: 'Record a month',
      description:
        'Save month-end balances of accounts and/or net incomes of members for one month (upsert: fields given replace that month’s entry). Typical input: numbers read from banking-app screenshots. For investment accounts also pass the unrealized gain if visible (it is taxed if sold). Debts: negative balance (a positive number for a debt account is stored as negative). Returns what is still missing for that month.',
      inputSchema: z.object({
        month: z.string().describe('YYYY-MM'),
        balances: z
          .array(
            z.object({
              account: z.string().describe('Account id or name'),
              balance: z.number(),
              unrealizedGain: z.number().optional(),
              allocations: z.array(z.object({ member: z.string(), amount: z.number() })).optional().describe('Explicit amounts belonging to members this month (e.g. personal deposits in a joint account); remainder follows the account shares'),
              note: z.string().optional(),
            }),
          )
          .default([]),
        incomes: z
          .array(
            z.object({
              member: z.string().describe('Member id or name'),
              net: z.number().describe('Regular net income of the month (net salary, pension, average freelance income)'),
              extra: z.number().optional().describe('One-offs: bonus, 13th/14th month, refunds'),
              note: z.string().optional(),
            }),
          )
          .default([]),
      }),
    },
    async ({ month, balances, incomes }) => {
      if (!isMonthKey(month)) return fail('month must be YYYY-MM');
      const st = store.load();
      if (!st.members.length) return fail('Household not set up: call conti_setup first.');
      const snaps = [];
      const errs: string[] = [];
      for (const b of balances) {
        const a = findAccount(st, b.account);
        if (!a) {
          errs.push(`unknown account "${b.account}"`);
          continue;
        }
        let alloc: Record<string, number> | undefined;
        if (b.allocations?.length) {
          alloc = {};
          for (const x of b.allocations) {
            const m = findMember(st, x.member);
            if (!m) errs.push(`unknown member "${x.member}"`);
            else alloc[m.id] = x.amount;
          }
        }
        const balance = a.kind === 'debt' && b.balance > 0 ? -b.balance : b.balance;
        snaps.push({ accountId: a.id, month, balance, unrealizedGain: b.unrealizedGain, allocations: alloc, note: b.note });
      }
      const incs = [];
      for (const i of incomes) {
        const m = findMember(st, i.member);
        if (!m) errs.push(`unknown member "${i.member}"`);
        else incs.push({ memberId: m.id, month, net: i.net, extra: i.extra, note: i.note });
      }
      if (errs.length)
        return fail(
          `Nothing saved: ${errs.join('; ')}. Accounts: ${st.accounts.map((a) => `${a.name} (${a.id})`).join(', ')}. Members: ${st.members.map((m) => m.name).join(', ')}. Create missing accounts with conti_upsert_account.`,
        );
      store.recordMonth(snaps, incs);
      const { st: s2, L, c } = load();
      const row = c.rows.find((r) => r.month === month);
      const s = c.statusOf(month);
      const miss = [...s.missingAccounts.map((id) => s2.accounts.find((a) => a.id === id)?.name ?? id), ...s.missingIncomes.map((id) => `${ownerName(s2, id, L)} income`)];
      const T = t(L);
      const lines = [
        `Saved ${snaps.length} balance(s) and ${incs.length} income(s) for ${monthLabel(month, L)}.`,
        row ? `${T.netWorth}: ${money(row.total.realizable, c.currency, L)}. ${T.savings}: ${money(row.savings.total, c.currency, L, true)}${isNum(row.spending.total) ? `, ${T.spending.toLowerCase()}: ${money(row.spending.total, c.currency, L)}` : ''}.` : '',
        s.overall === 'ok' ? 'The month is complete.' : `Still missing for ${month}: ${miss.join(', ')}.`,
      ];
      return ok(lines.filter(Boolean).join('\n'), { month, status: s, row: row ? { ...row, status: undefined } : null });
    },
  );

  server.registerTool(
    'conti_delete_entries',
    {
      title: 'Delete monthly entries',
      description: 'Remove balances and/or incomes recorded for a month (to fix mistakes).',
      inputSchema: z.object({ month: z.string(), accounts: z.array(z.string()).default([]), members: z.array(z.string()).default([]) }),
      annotations: { destructiveHint: true },
    },
    async ({ month, accounts, members }) => {
      const st = store.load();
      const aIds = accounts.map((a) => findAccount(st, a)?.id).filter((x): x is string => !!x);
      const mIds = members.map((m) => findMember(st, m)?.id).filter((x): x is string => !!x);
      const n = store.deleteEntries(month, aIds, mIds);
      return ok(`Deleted ${n} entr${n === 1 ? 'y' : 'ies'} for ${month}.`);
    },
  );

  // ---------------------------------------------------------- budget
  server.registerTool(
    'conti_upsert_budget_item',
    {
      title: 'Add or update a budget item',
      description: 'Fixed monthly or yearly commitments (rent, utilities, insurance, subscriptions) and planned savings (accumulation plans). Used to compare planned vs actual spending.',
      inputSchema: z.object({
        id: z.string().optional(),
        name: z.string(),
        amount: z.number().min(0),
        frequency: z.enum(['monthly', 'annual']).default('monthly'),
        dueMonth: z.number().int().min(1).max(12).optional().describe('For yearly items'),
        owner: z.string().nullable().optional().describe('Member id/name; null or omitted = shared'),
        kind: z.enum(['expense', 'saving']).default('expense'),
        category: z.string().optional(),
        note: z.string().optional(),
      }),
    },
    async (b) => {
      const st = store.load();
      let ownerId: string | null = null;
      if (b.owner) {
        const m = findMember(st, b.owner);
        if (!m) return fail(`Unknown member "${b.owner}".`);
        ownerId = m.id;
      }
      const ex = b.id ? st.budget.find((x) => x.id === b.id) : st.budget.find((x) => x.name.toLowerCase() === b.name.toLowerCase() && (x.ownerId ?? null) === ownerId);
      const item = { id: ex?.id ?? newId('b'), name: b.name, amount: b.amount, frequency: b.frequency, dueMonth: b.dueMonth, ownerId, kind: b.kind, category: b.category, note: b.note };
      store.upsertBudgetItem(item);
      const { L, c } = load();
      return ok(`Saved "${item.name}". Fixed commitments now ${money(c.budget.fixedMonthlyEquivalent, c.currency, L)}/month (yearly items spread over 12 months).`, { item });
    },
  );

  server.registerTool(
    'conti_delete_budget_item',
    {
      title: 'Delete a budget item',
      description: 'Remove a budget item by id or name.',
      inputSchema: z.object({ item: z.string() }),
      annotations: { destructiveHint: true },
    },
    async ({ item }) => {
      const st = store.load();
      const b = st.budget.find((x) => x.id === item) ?? st.budget.find((x) => x.name.toLowerCase() === item.toLowerCase());
      if (!b) return fail(`No budget item matches "${item}".`);
      store.deleteBudgetItem(b.id);
      return ok(`Deleted "${b.name}".`);
    },
  );

  server.registerTool(
    'conti_update_settings',
    {
      title: 'Update settings',
      description: 'Assumptions used by the calculations: capital-gains tax, emergency-fund target, max mortgage payment ratio, target savings rate, reference year; plus language and currency.',
      inputSchema: z.object({
        capitalGainsTax: z.number().min(0).max(0.6).optional(),
        emergencyMonths: z.number().min(0).max(36).optional(),
        maxPaymentRatio: z.number().min(0.05).max(0.6).optional(),
        targetSavingsRate: z.number().min(0).max(0.9).optional(),
        referenceYear: z.number().int().nullable().optional(),
        relevanceThreshold: z.number().min(0).max(1).optional().describe('A purchase is "relevant" above this share of monthly net income (default 0.2)'),
        modules: z
          .object({
            invest: moduleModeEnum.optional(),
            home: moduleModeEnum.optional(),
            debt: moduleModeEnum.optional(),
            fixed: moduleModeEnum.optional(),
          })
          .optional()
          .describe('Force optional modules on/off, or "auto" to let goals and data decide'),
        reminder: z
          .object({
            day: z.number().int().min(1).max(31).optional().describe('Day of the month for the monthly-update reminder'),
            channel: z.enum(['calendar', 'task', 'passive']).optional(),
            extras: z
              .object({ yearReview: z.boolean().optional(), annualExpense: z.boolean().optional(), goalMilestones: z.boolean().optional() })
              .optional(),
          })
          .optional(),
        locale: z.enum(['en', 'it']).optional(),
        currency: z.string().length(3).optional(),
        householdName: z.string().optional(),
      }),
      annotations: { idempotentHint: true },
    },
    async ({ locale, currency, householdName, modules, reminder, ...patch }) => {
      const st = store.load();
      if (locale || currency || householdName) {
        const h = st.household ?? { name: 'Household', currency: 'EUR', locale: 'en' as Locale, createdAt: new Date().toISOString() };
        store.setHousehold({ ...h, locale: locale ?? h.locale, currency: currency?.toUpperCase() ?? h.currency, name: householdName ?? h.name });
      }
      const clean: Partial<State['settings']> = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      if (modules) {
        const m = Object.fromEntries(Object.entries(modules).filter(([, v]) => v !== undefined));
        clean.modules = { ...st.settings.modules, ...m };
      }
      if (reminder) {
        const { extras, ...rest } = reminder;
        clean.reminder = {
          ...st.settings.reminder,
          ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)),
          ...(extras ? { extras: { ...st.settings.reminder?.extras, ...extras } } : {}),
        };
      }
      const s = Object.keys(clean).length ? store.updateSettings(clean) : store.load().settings;
      return ok(`Settings saved: ${JSON.stringify(s)}`, { settings: s });
    },
  );

  // ---------------------------------------------------------- goals
  server.registerTool(
    'conti_set_goal',
    {
      title: 'Set a goal',
      description:
        'Create or update a household goal: spending (understand where the money goes), emergency (build an emergency fund), home (buy a home), invest, debt (pay off a debt) or purchase (a significant purchase). The primary goal drives the dashboard header and tone — the first goal is primary by default. Optionally set a target amount and/or date, and link the accounts that count towards it (empty = liquidity beyond the emergency fund). Use status to mark a goal reached or archived.',
      inputSchema: z.object({
        id: z.string().optional().describe('Existing goal id to update; omit to create'),
        kind: goalKindEnum.describe('spending | emergency | home | invest | debt | purchase'),
        primary: z.boolean().optional().describe('Make this the main goal (the others become secondary)'),
        name: z.string().optional().describe('Custom label, e.g. "New kitchen"'),
        targetAmount: z.number().positive().optional(),
        targetDate: z.string().optional().describe('YYYY-MM or YYYY-MM-DD'),
        accounts: z.array(z.string()).default([]).describe('Accounts (id or name) that count towards the goal; empty = shared liquidity beyond the emergency fund'),
        status: z.enum(['active', 'reached', 'archived']).optional(),
      }),
      annotations: { idempotentHint: true },
    },
    async (g) => {
      const st = store.load();
      const accountIds: string[] = [];
      for (const ref of g.accounts) {
        const a = findAccount(st, ref);
        if (!a) return fail(`Unknown account "${ref}". Accounts: ${st.accounts.map((x) => x.name).join(', ') || 'none'}.`);
        accountIds.push(a.id);
      }
      const ex = g.id ? st.goals.find((x) => x.id === g.id) : undefined;
      if (g.id && !ex) return fail(`No goal with id "${g.id}".`);
      const makePrimary = g.primary ?? ex?.primary ?? st.goals.filter((x) => x.status !== 'archived').length === 0;
      const goal: Goal = {
        id: ex?.id ?? newId('goal'),
        kind: g.kind,
        primary: makePrimary,
        name: g.name ?? ex?.name,
        targetAmount: g.targetAmount ?? ex?.targetAmount,
        targetDate: g.targetDate ?? ex?.targetDate,
        accountIds: g.accounts.length ? accountIds : ex?.accountIds ?? [],
        status: g.status ?? ex?.status ?? 'active',
      };
      if (makePrimary) for (const other of st.goals) if (other.id !== goal.id && other.primary) store.upsertGoal({ ...other, primary: false });
      store.upsertGoal(goal);
      const { st: s2, L, c } = load();
      const gp = goalProgress(s2, c, goal);
      const T = t(L).goals;
      const cur = c.currency;
      const lines = [`${L === 'it' ? 'Obiettivo salvato' : 'Goal saved'}: ${goalLabel(goal, L)}${goal.primary ? ` (${T.primary})` : ''}.`];
      if (isNum(gp.target))
        lines.push(`${T.progress}: ${money(gp.accumulated, cur, L)} / ${money(gp.target, cur, L)} (${pct(gp.pct, L)})${gp.etaDate ? ` · ${monthLabel(gp.etaDate, L)} ${T.eta}` : ''}.`);
      else lines.push(`${T.progress}: ${money(gp.accumulated, cur, L)} (${T.noTarget}).`);
      return ok(lines.join('\n'), { goal, progress: gp });
    },
  );

  server.registerTool(
    'conti_delete_goal',
    {
      title: 'Delete a goal',
      description: 'Remove a goal. To keep it in history instead, call conti_set_goal with status "reached" or "archived".',
      inputSchema: z.object({ goal: z.string().describe('Goal id, name or kind') }),
      annotations: { destructiveHint: true },
    },
    async ({ goal }) => {
      const st = store.load();
      const r = goal.trim().toLowerCase();
      const g =
        st.goals.find((x) => x.id === goal) ??
        st.goals.find((x) => (x.name ?? '').toLowerCase() === r) ??
        st.goals.find((x) => x.kind === r);
      if (!g) return fail(`No goal matches "${goal}".`);
      store.deleteGoal(g.id);
      const { L } = load();
      return ok(`${L === 'it' ? 'Obiettivo eliminato' : 'Deleted goal'}: ${goalLabel(g, L)}.`);
    },
  );

  // ---------------------------------------------------------- simulations
  registerAppTool(
    server,
    'conti_home_scenario',
    {
      title: 'Home purchase scenario',
      description:
        'Simulate buying a home with the household’s real numbers: own funds from liquid wealth, family help, agency fee + VAT, closing costs, mortgage needed, payment for 20/25/30 years vs a sustainable share of net income, maximum affordable price, reserve left for emergencies. Set save=true to keep the scenario in the dashboard.',
      inputSchema: z.object({ ...scenarioInput, save: z.boolean().default(false) }),
      _meta: { ui: { resourceUri: UI_URI } },
    },
    async ({ save, capitalUse, ...a }) => {
      const st = store.load();
      const cu: Record<string, number> = {};
      for (const x of capitalUse) {
        const m = findMember(st, x.member);
        if (!m) return fail(`Unknown member "${x.member}".`);
        cu[m.id] = x.share;
      }
      const prev = a.id ? st.scenarios.find((s) => s.id === a.id) : undefined;
      const sc: HomeScenario = { ...(prev ?? {}), ...a, id: a.id ?? newId('home'), capitalUse: { ...(prev?.capitalUse ?? {}), ...cu } };
      if (save) store.upsertScenario(sc);
      const { st: s2, L, c } = load();
      const r = simulateHome(s2, c, sc);
      const T = t(L).home;
      const cur = c.currency;
      const lines = [
        `## ${sc.name}: ${money(sc.price, cur, L)}`,
        `${T.totalCost}: ${money(r.totalCost, cur, L)} (agency ${money(r.agencyFee, cur, L)}, other costs ${money(r.closingCosts, cur, L)}).`,
        `${T.ownFunds}: ${money(r.ownFunds, cur, L)} + ${T.familyHelp.toLowerCase()} ${money(r.familyHelp, cur, L)} → ${T.mortgage.toLowerCase()} ${money(r.mortgage, cur, L)} (LTV ${pct(r.ltv, L)}).`,
        `${T.maxPayment}: ${money(r.maxPayment, cur, L)} (${pct(s2.settings.maxPaymentRatio, L)} of net income ${money(r.householdNetIncome, cur, L)}).`,
        ...r.durations.map(
          (d) => `- ${d.years} ${T.years}: ${money(d.payment, cur, L)}/month (${pct(d.paymentRatio, L)} of income) → ${d.affordable === null ? '?' : d.affordable ? T.affordable : T.notAffordable}; interest ${money(d.totalInterest, cur, L)}; ${T.maxPrice.toLowerCase()} ${money(d.maxPriceWithSavings, cur, L)}`,
        ),
        `${T.reserve}: ${money(r.reserve, cur, L)} = ${num(r.reserveMonths, L, 1)} months of spending (target ${r.reserveTarget}).`,
        ...r.flags.map((f) => `⚠ ${T.flags[f]}`),
        save ? `Saved as scenario "${sc.id}".` : 'Not saved (pass save=true to keep it).',
      ];
      return ok(lines.join('\n'), { tab: 'home', scenarioId: save ? sc.id : null, result: r as unknown as Record<string, unknown> });
    },
  );

  server.registerTool(
    'conti_delete_home_scenario',
    {
      title: 'Delete a home scenario',
      description: 'Remove a saved home purchase scenario.',
      inputSchema: z.object({ id: z.string() }),
      annotations: { destructiveHint: true },
    },
    async ({ id }) => (store.deleteScenario(id) ? ok('Deleted.') : fail('Not found.')),
  );

  registerAppTool(
    server,
    'conti_simulate_purchase',
    {
      title: 'Can I afford it?',
      description:
        'Check a purchase (car, sofa, holiday, renovation…) against the household’s real numbers: cash vs liquid funds, emergency fund after the purchase, loan payment and total interest, new monthly commitment as % of income, months of savings it costs, opportunity cost if the cash were invested. Returns a verdict (comfortable / stretch / risky) with reasons. Use it to teach, not to decide for the user.',
      inputSchema: z.object({
        name: z.string().optional(),
        price: z.number().positive(),
        downPayment: z.number().min(0).optional().describe('Cash paid upfront; default = full price'),
        rate: z.number().min(0).max(0.5).optional().describe('Loan TAN/APR as fraction'),
        years: z.number().min(0).max(30).optional(),
        monthlyRunningCost: z.number().min(0).optional().describe('Insurance, fuel, maintenance, subscriptions…'),
        expectedReturn: z.number().min(0).max(0.2).optional().describe('Return if invested instead, default 3%'),
        horizonYears: z.number().min(1).max(40).optional(),
      }),
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: UI_URI } },
    },
    async (p) => {
      const { st, L, c } = load();
      const r = simulatePurchase(st, c, p);
      const T = t(L).purchase;
      const cur = c.currency;
      const lines = [
        `## ${p.name ?? T.title}: ${money(r.input.price, cur, L)} → **${T.verdict[r.verdict]}**`,
        r.loan > 0 ? `Loan ${money(r.loan, cur, L)} over ${r.input.years} years at ${pct(r.input.rate, L, 1)}: ${money(r.payment, cur, L)}/month, interest ${money(r.totalInterest, cur, L)}.` : `Paid in cash.`,
        `New monthly commitment: ${money(r.newMonthlyCommitment, cur, L)} (${pct(r.incomeShare, L)} of income).`,
        `Cash after: ${money(r.cashAfter, cur, L)} → emergency fund ${num(r.emergencyMonthsBefore, L, 1)} → ${num(r.emergencyMonthsAfter, L, 1)} months (target ${r.emergencyTarget}).`,
        isNum(r.monthsOfSavings) ? `Upfront cash = ${num(r.monthsOfSavings, L, 1)} months of household savings.` : '',
        `${T.opportunity}: ${money(r.opportunityCost, cur, L)} if the upfront cash were invested at ${pct(r.input.expectedReturn, L, 1)} for ${r.input.horizonYears} years.`,
        ...r.reasons.map((x) => `- ${T.reasons[x]}`),
      ];
      return ok(lines.filter(Boolean).join('\n'), { tab: 'purchase', result: r as unknown as Record<string, unknown> });
    },
  );

  registerAppTool(
    server,
    'conti_purchase_budget',
    {
      title: 'How much can I spend?',
      description:
        'The reverse of "can I afford it?": how much the household could spend on a purchase while keeping the emergency fund intact — in cash, and (when a rate and duration are given) using financing up to a sustainable monthly payment. Use it when the user asks "how much can we spend on …" rather than naming a price.',
      inputSchema: z.object({
        rate: z.number().min(0).max(0.5).optional().describe('Loan TAN/APR as a fraction, for the financed option'),
        years: z.number().min(0).max(30).optional().describe('Loan duration for the financed option'),
        monthlyRunningCost: z.number().min(0).optional().describe('Ongoing monthly cost the purchase would add (insurance, fuel…)'),
      }),
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: UI_URI } },
    },
    async (p) => {
      const { st, L, c } = load();
      const r = purchaseBudget(st, c, p);
      const T = t(L).purchaseBudget;
      const cur = c.currency;
      const lines = [
        `## ${T.title}`,
        `${T.maxCash}: ${money(r.maxCash, cur, L)}${isNum(r.emergencyReserve) ? ` (${money(r.emergencyReserve, cur, L)} ${T.emergencyReserve})` : ''}.`,
      ];
      if (isNum(r.maxFinanced) && isNum(r.maxLoanAmount) && isNum(r.monthlyPaymentCeiling))
        lines.push(
          `${T.maxFinanced}: ${money(r.maxFinanced, cur, L)} = ${money(r.downUsed, cur, L)} + ${money(r.maxLoanAmount, cur, L)} (${money(r.monthlyPaymentCeiling - r.monthlyRunningCost, cur, L)}/month).`,
        );
      for (const reason of r.reasons) lines.push(`⚠ ${T.reasons[reason]}`);
      return ok(lines.join('\n'), { tab: 'purchase', result: r as unknown as Record<string, unknown> });
    },
  );

  // ---------------------------------------------------------- import / export
  server.registerTool(
    'conti_export',
    {
      title: 'Export data',
      description: 'Full JSON backup of the household data (to save, migrate or inspect).',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const st = store.load();
      return ok(JSON.stringify({ format: 'conti-mcp', exportedAt: new Date().toISOString(), state: st }, null, 2));
    },
  );

  server.registerTool(
    'conti_import',
    {
      title: 'Import data',
      description: 'Replace all data with a JSON backup: a conti-mcp export, or a backup from the original "Conti congiunti" Claude artifact (auto-detected). This overwrites everything: only after explicit confirmation.',
      inputSchema: z.object({
        json: z.string().describe('The backup file content'),
        confirm: z.literal(true),
        memberNames: z.object({ a: z.string().optional(), b: z.string().optional() }).optional().describe('Legacy backups only: names for the two people'),
      }),
      annotations: { destructiveHint: true },
    },
    async ({ json, memberNames }) => {
      let raw: unknown;
      try {
        raw = JSON.parse(json);
      } catch {
        return fail('Not valid JSON.');
      }
      let st: State;
      if (isLegacyBackup(raw)) st = fromLegacy(raw as Record<string, unknown>, memberNames ?? {});
      else if (raw && typeof raw === 'object' && 'state' in raw) st = (raw as { state: State }).state;
      else return fail('Unrecognized format.');
      if (!Array.isArray(st.members) || !Array.isArray(st.accounts)) return fail('Backup is missing members/accounts.');
      store.replaceAll(st);
      const { st: s2, L, c } = load();
      return ok(`Imported ${s2.members.length} members, ${s2.accounts.length} accounts, ${s2.snapshots.length} balances, ${s2.incomes.length} incomes.\n\n${overviewText(s2, c, L)}`);
    },
  );

  return server;
}
