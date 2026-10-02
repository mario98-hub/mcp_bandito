/**
 * Pure calculation engine. No I/O: the same code runs on the server (for the
 * model-facing tools) and is unit-tested in isolation.
 *
 * Definitions (all amounts in the household currency):
 * - gross        = account balance
 * - book         = balance − unrealized gain          (what you put in + realized results)
 * - realizable   = balance − unrealized gain × tax    (what you'd have if you sold today)
 * - savings(m)   = book(m) − book(m−1), over accounts known in both months
 * - spending(m)  = income(m) − savings(m)
 *
 * Savings are measured from balances, not from transactions: no bank
 * connection, no categorisation, five minutes a month.
 */
import {
  SHARED,
  type Account,
  type HomeScenario,
  type Income,
  type Member,
  type MonthKey,
  type Settings,
  type Snapshot,
  type State,
} from './types.js';

// ---------------------------------------------------------------- utilities

export const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const N = (x: unknown) => (isNum(x) ? x : 0);
export const mk = (y: number, m: number): MonthKey => `${y}-${String(m).padStart(2, '0')}`;
export const parseKey = (k: MonthKey) => {
  const [y, m] = k.split('-').map(Number);
  return { y: y!, m: m! };
};
export const prevKey = (k: MonthKey) => {
  const { y, m } = parseKey(k);
  return m === 1 ? mk(y - 1, 12) : mk(y, m - 1);
};
export const nextKey = (k: MonthKey) => {
  const { y, m } = parseKey(k);
  return m === 12 ? mk(y + 1, 1) : mk(y, m + 1);
};
export const yearOf = (k: MonthKey) => parseKey(k).y;
export const isMonthKey = (k: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(k);
export function monthRange(a?: MonthKey, b?: MonthKey): MonthKey[] {
  const out: MonthKey[] = [];
  if (!a || !b || a > b) return out;
  for (let k = a; k <= b; k = nextKey(k)) out.push(k);
  return out;
}
const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
const ratio = (a: number | null, b: number | null) => (isNum(a) && isNum(b) && b !== 0 ? a / b : null);

/** Excel PMT(rate, nper, pv) with fv = 0, type = 0. Returns a negative number for a positive pv. */
export function PMT(r: number, n: number, pv: number) {
  if (r === 0) return -pv / n;
  const f = Math.pow(1 + r, n);
  return -(pv * r * f) / (f - 1);
}
/** Excel PV(rate, nper, pmt) with fv = 0, type = 0. */
export function PV(r: number, n: number, pmt: number) {
  if (r === 0) return -pmt * n;
  return (-pmt * (1 - Math.pow(1 + r, -n))) / r;
}
/** Monthly payment for a loan (positive number). */
export function loanPayment(principal: number, annualRate: number, years: number) {
  if (principal <= 0 || years <= 0) return 0;
  return PMT(annualRate / 12, years * 12, -principal);
}
/** Max principal a given monthly payment can service. */
export function maxLoan(payment: number, annualRate: number, years: number) {
  if (payment <= 0 || years <= 0) return 0;
  return PV(annualRate / 12, years * 12, -payment);
}

// ---------------------------------------------------------------- types

export interface Amounts {
  gross: number;
  book: number;
  realizable: number;
}
const zero = (): Amounts => ({ gross: 0, book: 0, realizable: 0 });
const add = (a: Amounts, b: Amounts) => {
  a.gross += b.gross;
  a.book += b.book;
  a.realizable += b.realizable;
};

export interface OwnerRef {
  id: string; // member id or SHARED
  name: string;
  color?: string;
}

export interface MonthRow {
  month: MonthKey;
  byOwner: Record<string, Amounts>;
  total: Amounts;
  /** Liquid wealth (liquid accounts), realizable, per owner and total. */
  liquid: Record<string, number> & { total: number };
  /** Cash-kind accounts only, realizable. */
  cash: number;
  debts: number;
  income: Record<string, { net: number; extra: number; total: number } | null>;
  incomeTotal: number | null;
  /** Δbook vs previous month, per owner (members + SHARED) and total. */
  savings: Record<string, number | null> & { total: number | null };
  /** income − savings, per member and total (total = all income − all savings). */
  spending: Record<string, number | null> & { total: number | null };
  /** Accounts whose value was carried forward from an earlier month. */
  carried: string[];
  status: MonthStatus;
}

export type Fill = 'ok' | 'partial' | 'missing';
export interface MonthStatus {
  month: MonthKey;
  overall: Fill;
  accounts: Record<string, boolean>;
  incomes: Record<string, boolean>;
  missingAccounts: string[];
  missingIncomes: string[];
}

export interface YearRow {
  year: number;
  owner: string; // member id, SHARED or 'total'
  months: number;
  avgNet: number | null;
  avgIncome: number | null;
  avgSavings: number | null;
  avgSpending: number | null;
  totalSavings: number | null;
  savingsRate: number | null;
  endBook: number | null;
  endRealizable: number | null;
}

export type HealthStatus = 'good' | 'ok' | 'warn' | 'na' | 'info';
export interface HealthMetric {
  id:
    | 'savingsRate'
    | 'emergencyFund'
    | 'fixedCosts'
    | 'debtRatio'
    | 'idleCash'
    | 'freshness';
  value: number | null;
  target: number | null;
  status: HealthStatus;
}

export interface Computed {
  currency: string;
  owners: OwnerRef[];
  months: MonthKey[];
  latestMonth: MonthKey | null;
  rows: MonthRow[];
  years: YearRow[];
  refYear: number | null;
  refYearAuto: boolean;
  netWorth: {
    asOf: MonthKey | null;
    total: Amounts;
    byOwner: Record<string, Amounts>;
    byKind: Record<string, number>;
    liquid: number;
    cash: number;
    debts: number;
    unrealizedGainsAfterTax: number;
    taxOnGains: number;
  };
  flows: {
    year: number | null;
    perMember: Record<string, YearRow | null>;
    household: YearRow | null;
    history: { year: number; savingsRate: number | null; avgSavings: number | null }[];
  };
  budget: BudgetSummary;
  health: HealthMetric[];
  statusOf: (month: MonthKey) => MonthStatus;
}

export interface BudgetSummary {
  monthlyExpenses: number;
  annualExpenses: number;
  annualAsMonthly: number;
  plannedSavings: number;
  /** monthly expenses + annual/12 */
  fixedMonthlyEquivalent: number;
  perOwner: Record<
    string,
    {
      monthlyExpenses: number;
      annualAsMonthly: number;
      plannedSavings: number;
      income: number | null;
      theoreticalSavings: number | null;
      actualSavings: number | null;
      gap: number | null;
    }
  >;
  household: {
    income: number | null;
    theoreticalSavings: number | null;
    actualSavings: number | null;
    actualSpending: number | null;
    /** actual average spending − planned fixed spending: the "variable" part. */
    variableSpending: number | null;
  };
  byMonthDue: Record<number, number>;
}

// ---------------------------------------------------------------- core

function accountAmounts(acc: Account, s: Snapshot, tax: number): Amounts {
  const g = N(s.unrealizedGain);
  return { gross: s.balance, book: s.balance - g, realizable: s.balance - g * tax };
}

/** Split an account's amounts among owners (members + SHARED). */
export function attribute(acc: Account, s: Snapshot, tax: number): Record<string, Amounts> {
  const a = accountAmounts(acc, s, tax);
  const out: Record<string, Amounts> = {};
  const scale = (f: number): Amounts => ({ gross: a.gross * f, book: a.book * f, realizable: a.realizable * f });
  if (s.allocations && Object.keys(s.allocations).length && a.gross !== 0) {
    // Explicit amounts are book amounts (deposits); gains stay with the remainder owner(s).
    let used = 0;
    for (const [id, amt] of Object.entries(s.allocations)) {
      if (!isNum(amt)) continue;
      out[id] = { gross: amt, book: amt, realizable: amt };
      used += amt;
    }
    const rest: Amounts = { gross: a.gross - used, book: a.book - used, realizable: a.realizable - used };
    const owners = acc.owners.filter((o) => !(o.memberId in (s.allocations ?? {})));
    const tot = sum(owners.map((o) => o.share));
    if (owners.length && tot > 0) {
      for (const o of owners) {
        const f = o.share / tot;
        const cur = (out[o.memberId] ??= zero());
        add(cur, { gross: rest.gross * f, book: rest.book * f, realizable: rest.realizable * f });
      }
    } else {
      add((out[SHARED] ??= zero()), rest);
    }
    return out;
  }
  let used = 0;
  for (const o of acc.owners) {
    const f = Math.max(0, Math.min(1, o.share));
    add((out[o.memberId] ??= zero()), scale(f));
    used += f;
  }
  if (used < 0.999999) add((out[SHARED] ??= zero()), scale(1 - used));
  return out;
}

export function compute(state: State, opts: { today?: MonthKey; settings?: Partial<Settings> } = {}): Computed {
  const S: Settings = { ...state.settings, ...(opts.settings ?? {}) };
  const tax = S.capitalGainsTax;
  const members: Member[] = state.members;
  const accounts = new Map(state.accounts.map((a) => [a.id, a]));
  const currency = state.household?.currency ?? 'EUR';

  // index snapshots and incomes
  const snapBy = new Map<string, Map<MonthKey, Snapshot>>();
  for (const s of state.snapshots) {
    if (!accounts.has(s.accountId) || !isNum(s.balance)) continue;
    let m = snapBy.get(s.accountId);
    if (!m) snapBy.set(s.accountId, (m = new Map()));
    m.set(s.month, s);
  }
  const incBy = new Map<string, Map<MonthKey, Income>>();
  for (const i of state.incomes) {
    let m = incBy.get(i.memberId);
    if (!m) incBy.set(i.memberId, (m = new Map()));
    m.set(i.month, i);
  }

  const allKeys = [
    ...state.snapshots.filter((s) => accounts.has(s.accountId)).map((s) => s.month),
    ...state.incomes.map((i) => i.month),
  ].sort();
  const months = monthRange(allKeys[0], allKeys[allKeys.length - 1]);
  const firstSnap = new Map<string, MonthKey>();
  for (const [id, m] of snapBy) firstSnap.set(id, [...m.keys()].sort()[0]!);

  const statusOf = (month: MonthKey): MonthStatus => {
    const accs: Record<string, boolean> = {};
    for (const a of state.accounts) {
      if (a.archived) continue;
      const first = firstSnap.get(a.id);
      if (first && first > month) continue; // account not tracked yet
      // pensions and property change slowly: recorded when available, never "missing"
      if (a.kind === 'pension' || a.kind === 'property') continue;
      accs[a.id] = !!snapBy.get(a.id)?.has(month);
    }
    const incs: Record<string, boolean> = {};
    for (const m of members) incs[m.id] = !!incBy.get(m.id)?.has(month);
    const vals = [...Object.values(accs), ...Object.values(incs)];
    const done = vals.filter(Boolean).length;
    return {
      month,
      overall: vals.length && done === vals.length ? 'ok' : done > 0 ? 'partial' : 'missing',
      accounts: accs,
      incomes: incs,
      missingAccounts: Object.keys(accs).filter((k) => !accs[k]),
      missingIncomes: Object.keys(incs).filter((k) => !incs[k]),
    };
  };

  // ---- month rows
  const rows: MonthRow[] = [];
  const last = new Map<string, Snapshot>(); // carried snapshot per account
  let prevAttr: Map<string, Record<string, Amounts>> | null = null;
  let hasShared = false;

  for (const month of months) {
    const attr = new Map<string, Record<string, Amounts>>();
    const carried: string[] = [];
    for (const [id, acc] of accounts) {
      const exact = snapBy.get(id)?.get(month);
      if (exact) last.set(id, exact);
      const s = exact ?? last.get(id);
      if (!s) continue;
      if (!exact) carried.push(id);
      const at = attribute(acc, s, tax);
      if (at[SHARED]) hasShared = true;
      attr.set(id, at);
    }
    const byOwner: Record<string, Amounts> = {};
    const total = zero();
    const liquid: Record<string, number> & { total: number } = { total: 0 } as never;
    let cash = 0;
    let debts = 0;
    for (const [id, at] of attr) {
      const acc = accounts.get(id)!;
      for (const [o, a] of Object.entries(at)) {
        add((byOwner[o] ??= zero()), a);
        add(total, a);
        if (acc.liquid && acc.kind !== 'debt') {
          liquid[o] = N(liquid[o]) + a.realizable;
          liquid.total += a.realizable;
        }
        if (acc.kind === 'cash') cash += a.realizable;
        if (acc.kind === 'debt' || a.gross < 0) debts += Math.min(0, a.gross);
      }
    }

    // savings: Δbook over accounts present in both months
    const savings: Record<string, number | null> & { total: number | null } = { total: null } as never;
    if (prevAttr) {
      const acc: Record<string, number> = {};
      let tot = 0;
      let any = false;
      for (const [id, at] of attr) {
        const pa = prevAttr.get(id);
        if (!pa) continue;
        any = true;
        const owners = new Set([...Object.keys(at), ...Object.keys(pa)]);
        for (const o of owners) {
          const d = N(at[o]?.book) - N(pa[o]?.book);
          acc[o] = N(acc[o]) + d;
          tot += d;
        }
      }
      if (any) {
        for (const [o, v] of Object.entries(acc)) savings[o] = v;
        for (const m of members) if (!(m.id in savings)) savings[m.id] = 0;
        savings.total = tot;
      }
    }

    const income: MonthRow['income'] = {};
    let incTot = 0;
    let anyInc = false;
    for (const m of members) {
      const i = incBy.get(m.id)?.get(month);
      if (i && isNum(i.net)) {
        const e = N(i.extra);
        income[m.id] = { net: i.net, extra: e, total: i.net + e };
        incTot += i.net + e;
        anyInc = true;
      } else income[m.id] = null;
    }
    const spending: Record<string, number | null> & { total: number | null } = { total: null } as never;
    for (const m of members) {
      const inc = income[m.id];
      const sv = savings[m.id];
      spending[m.id] = inc && isNum(sv) ? inc.total - sv : null;
    }
    const allIncome = members.length > 0 && members.every((m) => income[m.id]);
    spending.total = allIncome && isNum(savings.total) ? incTot - savings.total : null;

    rows.push({
      month,
      byOwner,
      total,
      liquid,
      cash,
      debts,
      income,
      incomeTotal: anyInc ? incTot : null,
      savings,
      spending,
      carried,
      status: statusOf(month),
    });
    prevAttr = attr;
  }

  const owners: OwnerRef[] = members.map((m) => ({ id: m.id, name: m.name, color: m.color }));
  if (hasShared) owners.push({ id: SHARED, name: 'Shared', color: undefined });

  // ---- yearly summaries
  const yearsSet = [...new Set(rows.map((r) => yearOf(r.month)))].sort();
  const years: YearRow[] = [];
  const summarize = (year: number, owner: string): YearRow => {
    const rs = rows.filter((r) => yearOf(r.month) === year);
    const isTotal = owner === 'total';
    const isMember = members.some((m) => m.id === owner);
    const inc = rs
      .map((r) => (isTotal ? (members.every((m) => r.income[m.id]) ? r.incomeTotal : null) : r.income[owner]?.total ?? null))
      .filter((x): x is number => isNum(x) && x > 0);
    const net = rs
      .map((r) =>
        isTotal
          ? members.every((m) => r.income[m.id])
            ? sum(members.map((m) => r.income[m.id]!.net))
            : null
          : r.income[owner]?.net ?? null,
      )
      .filter((x): x is number => isNum(x) && x > 0);
    const sv = rs.map((r) => (isTotal ? r.savings.total : r.savings[owner])).filter(isNum);
    const sp = rs.map((r) => (isTotal ? r.spending.total : r.spending[owner])).filter(isNum);
    const lastRow = [...rs].reverse().find((r) => (isTotal ? true : r.byOwner[owner]));
    const aInc = avg(inc);
    const aSv = avg(sv);
    return {
      year,
      owner,
      months: rs.filter((r) => (isTotal ? r.status.overall !== 'missing' : isMember ? !!r.income[owner] : !!r.byOwner[owner])).length,
      avgNet: avg(net),
      avgIncome: aInc,
      avgSavings: aSv,
      avgSpending: avg(sp),
      totalSavings: sv.length ? sum(sv) : null,
      savingsRate: isMember || isTotal ? ratio(aSv, aInc) : null,
      endBook: lastRow ? (isTotal ? lastRow.total.book : lastRow.byOwner[owner]?.book ?? null) : null,
      endRealizable: lastRow ? (isTotal ? lastRow.total.realizable : lastRow.byOwner[owner]?.realizable ?? null) : null,
    };
  };
  for (const y of yearsSet) {
    for (const o of owners) years.push(summarize(y, o.id));
    years.push(summarize(y, 'total'));
  }

  // reference year: explicit, else latest year with any income
  const withIncome = rows.filter((r) => r.incomeTotal !== null);
  const autoYear = withIncome.length
    ? yearOf(withIncome[withIncome.length - 1]!.month)
    : opts.today
      ? yearOf(opts.today)
      : null;
  const refYear = isNum(S.referenceYear) ? S.referenceYear : autoYear;
  const yr = (owner: string) => years.find((y) => y.year === refYear && y.owner === owner) ?? null;

  // ---- net worth at the latest month
  const lastRow = rows[rows.length - 1];
  const byKind: Record<string, number> = {};
  if (lastRow) {
    for (const [id, s] of last) {
      const acc = accounts.get(id)!;
      byKind[acc.kind] = N(byKind[acc.kind]) + accountAmounts(acc, s, tax).realizable;
    }
  }
  const total = lastRow?.total ?? zero();
  const netWorth = {
    asOf: lastRow?.month ?? null,
    total,
    byOwner: lastRow?.byOwner ?? {},
    byKind,
    liquid: lastRow?.liquid.total ?? 0,
    cash: lastRow?.cash ?? 0,
    debts: lastRow?.debts ?? 0,
    unrealizedGainsAfterTax: total.realizable - total.book,
    taxOnGains: total.gross - total.realizable,
  };

  const perMember: Record<string, YearRow | null> = {};
  for (const m of members) perMember[m.id] = yr(m.id);
  const household = yr('total');
  const flows = {
    year: refYear,
    perMember,
    household,
    history: yearsSet
      .map((y) => years.find((r) => r.year === y && r.owner === 'total')!)
      .filter((r) => r.months >= 3)
      .map((r) => ({ year: r.year, savingsRate: r.savingsRate, avgSavings: r.avgSavings })),
  };

  const budget = summarizeBudget(state, perMember, household);
  const health = healthCheck(S, netWorth, household, budget, rows, opts.today);

  return {
    currency,
    owners,
    months,
    latestMonth: lastRow?.month ?? null,
    rows,
    years,
    refYear,
    refYearAuto: !isNum(S.referenceYear),
    netWorth,
    flows,
    budget,
    health,
    statusOf,
  };
}

function summarizeBudget(
  state: State,
  perMember: Record<string, YearRow | null>,
  household: YearRow | null,
): BudgetSummary {
  const items = state.budget;
  const ownerOf = (o?: string | null) => (o && state.members.some((m) => m.id === o) ? o : SHARED);
  const perOwner: BudgetSummary['perOwner'] = {};
  const blank = () => ({
    monthlyExpenses: 0,
    annualAsMonthly: 0,
    plannedSavings: 0,
    income: null,
    theoreticalSavings: null,
    actualSavings: null,
    gap: null,
  });
  for (const m of state.members) perOwner[m.id] = blank();
  const byMonthDue: Record<number, number> = {};
  let monthly = 0;
  let annual = 0;
  let planned = 0;
  for (const it of items) {
    const o = (perOwner[ownerOf(it.ownerId)] ??= blank());
    const amt = N(it.amount);
    if (it.kind === 'saving') {
      const mAmt = it.frequency === 'annual' ? amt / 12 : amt;
      o.plannedSavings += mAmt;
      planned += mAmt;
    } else if (it.frequency === 'annual') {
      o.annualAsMonthly += amt / 12;
      annual += amt;
      if (it.dueMonth && it.dueMonth >= 1 && it.dueMonth <= 12) byMonthDue[it.dueMonth] = N(byMonthDue[it.dueMonth]) + amt;
    } else {
      o.monthlyExpenses += amt;
      monthly += amt;
    }
  }
  for (const m of state.members) {
    const o = perOwner[m.id]!;
    const y = perMember[m.id];
    o.income = y?.avgIncome ?? null;
    o.actualSavings = y?.avgSavings ?? null;
    o.theoreticalSavings = isNum(o.income) ? o.income - o.monthlyExpenses - o.annualAsMonthly : null;
    o.gap = isNum(o.actualSavings) && isNum(o.theoreticalSavings) ? o.actualSavings - o.theoreticalSavings : null;
  }
  const fixed = monthly + annual / 12;
  const inc = household?.avgIncome ?? null;
  return {
    monthlyExpenses: monthly,
    annualExpenses: annual,
    annualAsMonthly: annual / 12,
    plannedSavings: planned,
    fixedMonthlyEquivalent: fixed,
    perOwner,
    household: {
      income: inc,
      theoreticalSavings: isNum(inc) ? inc - fixed : null,
      actualSavings: household?.avgSavings ?? null,
      actualSpending: household?.avgSpending ?? null,
      variableSpending: isNum(household?.avgSpending) && items.length ? household!.avgSpending! - fixed : null,
    },
    byMonthDue,
  };
}

function healthCheck(
  S: Settings,
  nw: Computed['netWorth'],
  hh: YearRow | null,
  budget: BudgetSummary,
  rows: MonthRow[],
  today?: MonthKey,
): HealthMetric[] {
  const out: HealthMetric[] = [];
  const grade = (v: number | null, good: (v: number) => boolean, ok: (v: number) => boolean): HealthStatus =>
    !isNum(v) ? 'na' : good(v) ? 'good' : ok(v) ? 'ok' : 'warn';

  const sr = hh?.savingsRate ?? null;
  out.push({
    id: 'savingsRate',
    value: sr,
    target: S.targetSavingsRate,
    status: grade(sr, (v) => v >= S.targetSavingsRate, (v) => v >= S.targetSavingsRate / 2),
  });

  const spend = hh?.avgSpending ?? null;
  const ef = isNum(spend) && spend > 0 ? nw.cash / spend : null;
  out.push({
    id: 'emergencyFund',
    value: ef,
    target: S.emergencyMonths,
    status: grade(ef, (v) => v >= S.emergencyMonths, (v) => v >= S.emergencyMonths / 2),
  });

  const inc = hh?.avgIncome ?? null;
  const fc = budget.fixedMonthlyEquivalent > 0 ? ratio(budget.fixedMonthlyEquivalent, inc) : null;
  out.push({ id: 'fixedCosts', value: fc, target: 0.5, status: grade(fc, (v) => v <= 0.5, (v) => v <= 0.65) });

  const assets = nw.total.gross - nw.debts; // debts are negative
  const dr = assets > 0 ? -nw.debts / assets : null;
  out.push({ id: 'debtRatio', value: dr, target: 0.3, status: nw.debts === 0 && assets > 0 ? 'good' : grade(dr, (v) => v <= 0.3, (v) => v <= 0.5) });

  // idle cash: cash beyond 2× the emergency target, as months of spending
  const idle = isNum(spend) && spend > 0 ? nw.cash / spend - S.emergencyMonths * 2 : null;
  out.push({ id: 'idleCash', value: isNum(idle) ? Math.max(0, idle) : null, target: S.emergencyMonths * 2, status: !isNum(idle) ? 'na' : idle > 0 ? 'info' : 'good' });

  // freshness: months since the last month with every account and income filled in
  const lastComplete = [...rows].reverse().find((r) => r.status.overall === 'ok')?.month ?? null;
  let gap: number | null = null;
  if (lastComplete && today) {
    const a = parseKey(lastComplete);
    const b = parseKey(today);
    gap = (b.y - a.y) * 12 + (b.m - a.m);
  }
  out.push({ id: 'freshness', value: gap, target: 1, status: grade(gap, (v) => v <= 1, (v) => v <= 2) });
  return out;
}

// ---------------------------------------------------------------- scenarios

export interface HomeResult {
  scenario: HomeScenario;
  perOwner: { id: string; liquid: number; use: number; toHouse: number; reserve: number }[];
  ownFunds: number;
  familyHelp: number;
  liquidity: number;
  agencyFee: number;
  closingCosts: number;
  totalCost: number;
  mortgage: number;
  ltv: number | null;
  householdNetIncome: number | null;
  maxPayment: number | null;
  durations: {
    years: number;
    payment: number;
    affordable: boolean | null;
    paymentRatio: number | null;
    totalInterest: number;
    maxMortgage: number | null;
    equityNeeded: number | null;
    equityCovered: boolean | null;
    maxPriceWithoutSavings: number | null;
    maxPriceWithSavings: number | null;
  }[];
  reserve: number;
  householdSpending: number | null;
  reserveMonths: number | null;
  reserveTarget: number;
  reserveGap: number | null;
  flags: ('ltvOver80' | 'reserveLow' | 'unaffordable' | 'noIncome' | 'noData')[];
}

export function simulateHome(state: State, c: Computed, sc: HomeScenario): HomeResult {
  const S = state.settings;
  const latest = c.rows[c.rows.length - 1];
  const ownerIds = [...state.members.map((m) => m.id), SHARED];
  const perOwner = ownerIds.map((id) => {
    const liquid = N(latest?.liquid[id]);
    const use = id === SHARED ? N(sc.sharedCapitalUse ?? 1) : isNum(sc.capitalUse?.[id]) ? sc.capitalUse[id]! : 1;
    return { id, liquid, use, toHouse: liquid * use, reserve: liquid * (1 - use) };
  }).filter((o) => o.id !== SHARED || o.liquid !== 0);
  const ownFunds = sum(perOwner.map((o) => o.toHouse));
  const reserve = sum(perOwner.map((o) => o.reserve));
  const help = N(sc.familyHelp);
  const liquidity = ownFunds + help;
  const price = N(sc.price);
  const kFee = 1 + N(sc.agencyFee) * (1 + N(sc.agencyFeeVat));
  const agencyFee = price * (kFee - 1);
  const closing = N(sc.closingCosts);
  const totalCost = price + agencyFee + closing;
  const mortgage = Math.max(0, totalCost - liquidity);

  const income = c.flows.household?.avgNet ?? null;
  const maxPayment = isNum(income) ? income * S.maxPaymentRatio : null;
  const durations = (sc.durations?.length ? sc.durations : [20, 25, 30]).map((years) => {
    const n = years * 12;
    const payment = loanPayment(mortgage, sc.rate, years);
    const maxM = isNum(maxPayment) ? maxLoan(maxPayment, sc.rate, years) : null;
    const equityNeeded = isNum(maxM) ? Math.max(0, totalCost - help - maxM) : null;
    return {
      years,
      payment,
      affordable: isNum(maxPayment) ? payment <= maxPayment + 0.005 : null,
      paymentRatio: ratio(payment, income),
      totalInterest: mortgage > 0 ? payment * n - mortgage : 0,
      maxMortgage: maxM,
      equityNeeded,
      equityCovered: isNum(equityNeeded) ? equityNeeded <= ownFunds : null,
      maxPriceWithoutSavings: isNum(maxM) ? (maxM + help - closing) / kFee : null,
      maxPriceWithSavings: isNum(maxM) ? (maxM + help + ownFunds - closing) / kFee : null,
    };
  });
  const spend = c.flows.household?.avgSpending ?? null;
  const reserveMonths = isNum(spend) && spend > 0 ? reserve / spend : null;
  const flags: HomeResult['flags'] = [];
  const ltv = price ? mortgage / price : null;
  if (!latest) flags.push('noData');
  if (!isNum(income)) flags.push('noIncome');
  if (isNum(ltv) && ltv > 0.8) flags.push('ltvOver80');
  if (isNum(reserveMonths) && reserveMonths < S.emergencyMonths) flags.push('reserveLow');
  if (durations.length && durations.every((d) => d.affordable === false)) flags.push('unaffordable');
  return {
    scenario: sc,
    perOwner,
    ownFunds,
    familyHelp: help,
    liquidity,
    agencyFee,
    closingCosts: closing,
    totalCost,
    mortgage,
    ltv,
    householdNetIncome: income,
    maxPayment,
    durations,
    reserve,
    householdSpending: spend,
    reserveMonths,
    reserveTarget: S.emergencyMonths,
    reserveGap: isNum(spend) ? reserve - spend * S.emergencyMonths : null,
    flags,
  };
}

export interface PurchaseInput {
  name?: string;
  price: number;
  /** Cash paid upfront. Defaults to the full price (no loan). */
  downPayment?: number;
  /** Annual loan rate (TAN). */
  rate?: number;
  /** Loan duration in years. */
  years?: number;
  /** Extra monthly running costs the purchase brings (insurance, fuel, maintenance…). */
  monthlyRunningCost?: number;
  /** Return the cash could earn if invested instead (for opportunity cost). */
  expectedReturn?: number;
  /** Horizon for the opportunity cost, years. Defaults to loan years or 5. */
  horizonYears?: number;
}

export interface PurchaseResult {
  input: Required<Omit<PurchaseInput, 'name'>> & { name: string };
  loan: number;
  payment: number;
  totalInterest: number;
  totalCost: number;
  newMonthlyCommitment: number;
  incomeShare: number | null;
  cashAfter: number;
  liquidAfter: number;
  emergencyMonthsBefore: number | null;
  emergencyMonthsAfter: number | null;
  emergencyTarget: number;
  monthsOfSavings: number | null;
  savingsAfter: number | null;
  opportunityCost: number;
  verdict: 'comfortable' | 'stretch' | 'risky' | 'unknown';
  reasons: ('cashShortfall' | 'emergencyBelowTarget' | 'emergencyBelowHalf' | 'paymentOver15' | 'paymentOver30' | 'negativeSavings' | 'manyMonthsOfSavings' | 'noSpendingData')[];
}

export function simulatePurchase(state: State, c: Computed, p: PurchaseInput): PurchaseResult {
  const S = state.settings;
  const price = N(p.price);
  const down = isNum(p.downPayment) ? Math.min(price, Math.max(0, p.downPayment)) : price;
  const rate = N(p.rate);
  const years = isNum(p.years) && p.years > 0 ? p.years : 0;
  const loan = price - down;
  const payment = loan > 0 && years > 0 ? loanPayment(loan, rate, years) : 0;
  const totalInterest = loan > 0 && years > 0 ? payment * years * 12 - loan : 0;
  const running = N(p.monthlyRunningCost);
  const expRet = isNum(p.expectedReturn) ? p.expectedReturn : 0.03;
  const horizon = isNum(p.horizonYears) && p.horizonYears > 0 ? p.horizonYears : years || 5;
  const spend = c.flows.household?.avgSpending ?? null;
  const income = c.flows.household?.avgIncome ?? null;
  const savings = c.flows.household?.avgSavings ?? null;
  const cash = c.netWorth.cash;
  const liquid = c.netWorth.liquid;
  const commit = payment + running;
  const efBefore = isNum(spend) && spend > 0 ? cash / spend : null;
  const cashAfter = cash - down;
  const efAfter = isNum(spend) && spend + commit > 0 ? cashAfter / (spend + commit) : null;
  const savingsAfter = isNum(savings) ? savings - commit : null;
  const reasons: PurchaseResult['reasons'] = [];
  if (!isNum(spend)) reasons.push('noSpendingData');
  if (down > liquid) reasons.push('cashShortfall');
  if (isNum(efAfter) && efAfter < S.emergencyMonths / 2) reasons.push('emergencyBelowHalf');
  else if (isNum(efAfter) && efAfter < S.emergencyMonths) reasons.push('emergencyBelowTarget');
  const share = ratio(commit, income);
  if (isNum(share) && share > 0.3) reasons.push('paymentOver30');
  else if (isNum(share) && share > 0.15) reasons.push('paymentOver15');
  if (isNum(savingsAfter) && savingsAfter < 0) reasons.push('negativeSavings');
  const mos = isNum(savings) && savings > 0 ? down / savings : null;
  if (isNum(mos) && mos > 12) reasons.push('manyMonthsOfSavings');
  const severe = reasons.some((r) => ['cashShortfall', 'emergencyBelowHalf', 'paymentOver30', 'negativeSavings'].includes(r));
  const mild = reasons.some((r) => ['emergencyBelowTarget', 'paymentOver15', 'manyMonthsOfSavings'].includes(r));
  const verdict: PurchaseResult['verdict'] = !isNum(spend) ? 'unknown' : severe ? 'risky' : mild ? 'stretch' : 'comfortable';
  return {
    input: {
      name: p.name ?? '',
      price,
      downPayment: down,
      rate,
      years,
      monthlyRunningCost: running,
      expectedReturn: expRet,
      horizonYears: horizon,
    },
    loan,
    payment,
    totalInterest,
    totalCost: price + totalInterest + running * 12 * horizon,
    newMonthlyCommitment: commit,
    incomeShare: share,
    cashAfter,
    liquidAfter: liquid - down,
    emergencyMonthsBefore: efBefore,
    emergencyMonthsAfter: efAfter,
    emergencyTarget: S.emergencyMonths,
    monthsOfSavings: mos,
    savingsAfter,
    opportunityCost: down * (Math.pow(1 + expRet, horizon) - 1),
    verdict,
    reasons,
  };
}
