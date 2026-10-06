import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compute,
  PMT,
  PV,
  attribute,
  simulateHome,
  simulatePurchase,
  loanPayment,
  maxLoan,
  onboardingNext,
  resolveModules,
  goalProgress,
  purchaseBudget,
} from '../dist/core/engine.js';
import { demoState } from '../dist/core/demo.js';
import { emptyState, SHARED } from '../dist/core/types.js';
import { fromLegacy } from '../dist/core/legacy.js';
import { STRINGS } from '../dist/core/i18n.js';

const close = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('i18n: en and it have matching keys and no empty strings', () => {
  const walk = (a, b, path) => {
    assert.equal(typeof b, typeof a, `type mismatch at ${path}`);
    if (typeof a === 'string') {
      assert.ok(a.length > 0, `empty en string at ${path}`);
      assert.ok(b.length > 0, `empty it string at ${path}`);
    } else if (typeof a === 'function') {
      assert.equal(typeof b, 'function', `it is not a function at ${path}`);
    } else if (a && typeof a === 'object') {
      assert.deepEqual(Object.keys(b).sort(), Object.keys(a).sort(), `key mismatch at ${path}`);
      for (const k of Object.keys(a)) walk(a[k], b[k], `${path}.${k}`);
    }
  };
  walk(STRINGS.en, STRINGS.it, '');
  // the v0.2 dashboard dicts exist in both locales
  for (const L of ['en', 'it']) {
    assert.ok(STRINGS[L].modules.title && STRINGS[L].modules.auto, `${L} modules`);
    assert.ok(STRINGS[L].goals.toGo, `${L} goals.toGo`);
    assert.ok(STRINGS[L].purchaseBudget.maxCash && STRINGS[L].purchaseBudget.maxFinanced, `${L} purchaseBudget`);
  }
});

test('PMT/PV match Excel', () => {
  // Excel: =PMT(0.035/12, 360, -200000) = 898.09
  close(PMT(0.035 / 12, 360, -200000), 898.09);
  close(PV(0.035 / 12, 360, -898.09), 200000, 1);
  close(PMT(0, 120, -12000), 100);
  close(loanPayment(0, 0.03, 20), 0);
});

test('attribution: shares, remainder to shared, explicit allocations', () => {
  const acc = { id: 'j', name: 'J', kind: 'cash', owners: [{ memberId: 'a', share: 0.5 }], liquid: true };
  const at = attribute(acc, { accountId: 'j', month: '2026-01', balance: 1000 }, 0.26);
  close(at.a.gross, 500);
  close(at[SHARED].gross, 500);
  const shared = { ...acc, owners: [] };
  const at2 = attribute(shared, { accountId: 'j', month: '2026-01', balance: 1000, allocations: { a: 300 } }, 0.26);
  close(at2.a.book, 300);
  close(at2[SHARED].book, 700);
  const inv = { id: 'i', name: 'I', kind: 'investment', owners: [{ memberId: 'a', share: 1 }], liquid: true };
  const at3 = attribute(inv, { accountId: 'i', month: '2026-01', balance: 10000, unrealizedGain: 1000 }, 0.26);
  close(at3.a.book, 9000);
  close(at3.a.realizable, 9740);
});

test('savings and spending from balance deltas', () => {
  const s = emptyState();
  s.members = [{ id: 'a', name: 'A' }];
  s.accounts = [{ id: 'x', name: 'X', kind: 'cash', owners: [{ memberId: 'a', share: 1 }], liquid: true }];
  s.snapshots = [
    { accountId: 'x', month: '2026-01', balance: 1000 },
    { accountId: 'x', month: '2026-02', balance: 1500 },
    { accountId: 'x', month: '2026-03', balance: 1700 },
  ];
  s.incomes = [
    { memberId: 'a', month: '2026-02', net: 2000 },
    { memberId: 'a', month: '2026-03', net: 2000, extra: 300 },
  ];
  const c = compute(s, { today: '2026-03' });
  assert.equal(c.rows.length, 3);
  assert.equal(c.rows[1].savings.a, 500);
  assert.equal(c.rows[1].spending.a, 1500);
  assert.equal(c.rows[2].savings.total, 200);
  assert.equal(c.rows[2].spending.total, 2100);
  const y = c.flows.household;
  close(y.avgSavings, 350);
  close(y.avgIncome, 2150);
  close(y.savingsRate, 350 / 2150);
  assert.equal(c.netWorth.total.realizable, 1700);
});

test('accounts appearing mid-history do not count as savings', () => {
  const s = emptyState();
  s.members = [{ id: 'a', name: 'A' }];
  s.accounts = [
    { id: 'x', name: 'X', kind: 'cash', owners: [{ memberId: 'a', share: 1 }], liquid: true },
    { id: 'y', name: 'Y', kind: 'investment', owners: [{ memberId: 'a', share: 1 }], liquid: true },
  ];
  s.snapshots = [
    { accountId: 'x', month: '2026-01', balance: 1000 },
    { accountId: 'x', month: '2026-02', balance: 1100 },
    { accountId: 'y', month: '2026-02', balance: 50000 },
  ];
  const c = compute(s);
  assert.equal(c.rows[1].savings.a, 100);
  assert.equal(c.rows[1].total.gross, 51100);
});

test('carry forward and month status', () => {
  const s = demoState('2026-09', 6);
  const c = compute(s, { today: '2026-09' });
  const last = c.rows[c.rows.length - 1];
  assert.ok(last.carried.includes('sam-bank'));
  assert.equal(last.status.overall, 'partial');
  assert.deepEqual(last.status.missingAccounts, ['sam-bank']);
  const prev = c.rows[c.rows.length - 2];
  assert.equal(prev.status.overall, 'ok');
});

test('demo household: sensible headline numbers', () => {
  const c = compute(demoState(), { today: '2026-09' });
  assert.equal(c.latestMonth, '2026-09');
  assert.ok(c.netWorth.total.realizable > 40000);
  assert.ok(c.netWorth.debts < 0);
  const sr = c.flows.household.savingsRate;
  assert.ok(sr > 0.05 && sr < 0.6, `savings rate ${sr}`);
  assert.equal(c.health.length, 6);
  assert.ok(c.owners.some((o) => o.id === SHARED));
  close(c.budget.fixedMonthlyEquivalent, 1050 + 160 + 12 + 45 + (620 + 2400) / 12);
});

test('home scenario mirrors the spreadsheet logic', () => {
  const st = demoState();
  const c = compute(st, { today: '2026-09' });
  const r = simulateHome(st, c, st.scenarios[0]);
  close(r.agencyFee, 290000 * 0.03 * 1.22);
  close(r.totalCost, 290000 + r.agencyFee + 9000);
  close(r.mortgage, Math.max(0, r.totalCost - r.ownFunds - 20000));
  const d30 = r.durations.find((d) => d.years === 30);
  close(d30.payment, -PMT(0.032 / 12, 360, r.mortgage));
  assert.equal(typeof d30.affordable, 'boolean');
  assert.ok(d30.maxPriceWithSavings > d30.maxPriceWithoutSavings);
});

test('purchase simulation verdicts', () => {
  const st = demoState();
  const c = compute(st, { today: '2026-09' });
  const small = simulatePurchase(st, c, { price: 800 });
  assert.equal(small.verdict, 'comfortable');
  const car = simulatePurchase(st, c, { price: 60000 });
  assert.equal(car.verdict, 'risky');
  assert.ok(car.reasons.includes('cashShortfall') || car.reasons.includes('emergencyBelowHalf'));
  const fin = simulatePurchase(st, c, { price: 25000, downPayment: 5000, rate: 0.069, years: 5, monthlyRunningCost: 150 });
  assert.ok(fin.payment > 380 && fin.payment < 420, String(fin.payment));
  assert.ok(fin.totalInterest > 0);
  assert.ok(fin.opportunityCost > 0);
});

test('legacy "Conti congiunti" backup import', () => {
  const legacy = {
    saldo_mario: {
      '2026-01': { fineco: 50000, plus: 4000, stipendio: 2800 },
      '2026-02': { fineco: 51000, plus: 4200, stipendio: 2800, extra: 500 },
    },
    saldo_chiara: { '2026-01': { conto: 20000, entrate: 1900 }, '2026-02': { conto: 20400, entrate: 1900 } },
    conto_comune: { '2026-01': { saldo: 6000, quotaMario: 2000 }, '2026-02': { saldo: 6300 } },
    config: {
      parametri: { valori: { aliquota: 0.26, prezzoCasa: 300000, tan: 0.031, cauzione: 1500, usoCapitaleMario: 0.8 } },
      spese_fisse: { mario: [{ voce: 'Affitto', importo: 900 }], chiara: [], pac: [{ voce: 'ETF', importo: 200 }] },
      spese_annuali: { voci: [{ voce: 'Assicurazione', mese: 'Marzo', importo: 600 }] },
    },
  };
  const st = fromLegacy(legacy);
  const c = compute(st, { today: '2026-02' });
  // A: fineco − plus×tax + quota + deposit
  close(c.rows[1].byOwner.m_a.realizable, 51000 - 4200 * 0.26 + 2000 + 1500);
  close(c.rows[1].byOwner._shared.realizable, 6300 - 2000);
  close(c.rows[1].savings.m_a, 51000 - 4200 - (50000 - 4000));
  assert.equal(st.budget.find((b) => b.name === 'Assicurazione').dueMonth, 3);
  assert.equal(st.budget.find((b) => b.name === 'ETF').kind, 'saving');
  assert.equal(st.scenarios[0].capitalUse.m_a, 0.8);
});

// ---------------------------------------------------------------- v0.2

test('onboardingNext derives the next step from the data', () => {
  const s = emptyState();
  assert.equal(onboardingNext(s).next.id, 'who');
  assert.equal(onboardingNext(s).onboarded, false);

  s.household = { name: 'H', currency: 'EUR', locale: 'it', createdAt: 'x' };
  s.members = [{ id: 'a', name: 'A' }];
  assert.equal(onboardingNext(s).next.id, 'goal');

  s.goals = [{ id: 'g1', kind: 'emergency', primary: true, accountIds: [], status: 'active' }];
  assert.equal(onboardingNext(s).next.id, 'accounts');

  // an account with no balance snapshot does not satisfy step 3
  s.accounts = [{ id: 'x', name: 'X', kind: 'cash', owners: [{ memberId: 'a', share: 1 }], liquid: true }];
  assert.equal(onboardingNext(s).next.id, 'accounts');

  s.snapshots = [{ accountId: 'x', month: '2026-01', balance: 1000 }];
  assert.equal(onboardingNext(s).next.id, 'income');
  assert.equal(onboardingNext(s).onboarded, false);

  s.incomes = [{ memberId: 'a', month: '2026-01', net: 2000 }];
  const r = onboardingNext(s);
  assert.equal(r.complete, true);
  assert.equal(r.onboarded, true);
  // emergency goal needs no amount (step 6 done); reminder not set → next is reminder
  assert.equal(r.next.id, 'reminder');
  assert.equal(r.steps.find((x) => x.id === 'goal').done, true);
});

test('resolveModules: auto from data, forced on/off', () => {
  const s = emptyState();
  s.accounts = [{ id: 'x', name: 'X', kind: 'cash', owners: [], liquid: true }];
  assert.deepEqual(resolveModules(s), { invest: false, home: false, debt: false, fixed: false });

  s.accounts.push({ id: 'd', name: 'Loan', kind: 'debt', owners: [], liquid: false });
  assert.equal(resolveModules(s).debt, true);

  s.accounts.push({ id: 'i', name: 'ETF', kind: 'investment', owners: [], liquid: true });
  assert.equal(resolveModules(s).invest, true);

  s.budget = [{ id: 'b', name: 'Rent', amount: 800, frequency: 'monthly', kind: 'expense' }];
  assert.equal(resolveModules(s).fixed, true);

  // manual override wins over the data
  s.settings.modules = { ...s.settings.modules, invest: 'off' };
  assert.equal(resolveModules(s).invest, false);

  // force a module on with no supporting data
  const s2 = emptyState();
  s2.settings.modules = { ...s2.settings.modules, home: 'on' };
  assert.equal(resolveModules(s2).home, true);
});

test('goalProgress: linked accounts and primary-first pool', () => {
  const s = emptyState();
  s.members = [{ id: 'a', name: 'A' }];
  s.accounts = [
    { id: 'cash', name: 'Cash', kind: 'cash', owners: [{ memberId: 'a', share: 1 }], liquid: true },
    { id: 'save', name: 'Savings', kind: 'cash', owners: [{ memberId: 'a', share: 1 }], liquid: true },
  ];
  s.snapshots = [
    { accountId: 'cash', month: '2026-01', balance: 10000 },
    { accountId: 'save', month: '2026-01', balance: 4000 },
    { accountId: 'cash', month: '2026-02', balance: 10000 },
    { accountId: 'save', month: '2026-02', balance: 5000 },
  ];
  s.incomes = [
    { memberId: 'a', month: '2026-01', net: 3000 },
    { memberId: 'a', month: '2026-02', net: 3000 },
  ];
  const c = compute(s, { today: '2026-02' });

  // linked goal: accumulated = realizable of the linked account
  const linked = { id: 'g-save', kind: 'purchase', primary: false, accountIds: ['save'], targetAmount: 10000, status: 'active' };
  s.goals = [linked];
  const gp = goalProgress(s, c, linked);
  close(gp.accumulated, 5000);
  close(gp.pct, 0.5);

  // two unlinked goals share the pool, primary first
  const pool = Math.max(0, c.netWorth.liquid - s.settings.emergencyMonths * c.flows.household.avgSpending);
  const primary = { id: 'g1', kind: 'home', primary: true, accountIds: [], targetAmount: 1000, status: 'active' };
  const second = { id: 'g2', kind: 'purchase', primary: false, accountIds: [], status: 'active' };
  s.goals = [primary, second];
  close(goalProgress(s, c, primary).accumulated, Math.min(1000, pool));
  close(goalProgress(s, c, second).accumulated, Math.max(0, pool - Math.min(1000, pool)));
});

test('purchaseBudget: cash keeps the emergency fund, financing respects the ratio', () => {
  const s = emptyState();
  s.members = [{ id: 'a', name: 'A' }];
  s.accounts = [{ id: 'cash', name: 'Cash', kind: 'cash', owners: [{ memberId: 'a', share: 1 }], liquid: true }];
  s.snapshots = [
    { accountId: 'cash', month: '2026-01', balance: 20000 },
    { accountId: 'cash', month: '2026-02', balance: 21000 },
  ];
  s.incomes = [
    { memberId: 'a', month: '2026-01', net: 3000 },
    { memberId: 'a', month: '2026-02', net: 3000 },
  ];
  const c = compute(s, { today: '2026-02' });
  const spend = c.flows.household.avgSpending;

  const b = purchaseBudget(s, c, {});
  close(b.maxCash, Math.max(0, c.netWorth.cash - s.settings.emergencyMonths * spend));
  assert.equal(b.maxFinanced, null); // no years → no financing option
  assert.equal(b.reasons.length, 0);

  const bf = purchaseBudget(s, c, { rate: 0.06, years: 5, monthlyRunningCost: 100 });
  const ceiling = c.flows.household.avgIncome * s.settings.maxPaymentRatio;
  close(bf.monthlyPaymentCeiling, ceiling);
  close(bf.maxLoanAmount, maxLoan(Math.max(0, ceiling - 100), 0.06, 5));
  close(bf.maxFinanced, bf.maxCash + bf.maxLoanAmount);
});
