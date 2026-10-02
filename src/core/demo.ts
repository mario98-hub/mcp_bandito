/** A fictional two-person household, used for the UI preview, docs and tests. */
import { DEFAULT_SETTINGS, type State, type Snapshot, type Income } from './types.js';
import { monthRange, nextKey } from './engine.js';

export function demoState(endMonth = '2026-09', months = 21): State {
  let start = endMonth;
  for (let i = 1; i < months; i++) {
    const [y, m] = start.split('-').map(Number);
    start = m === 1 ? `${y! - 1}-12` : `${y}-${String(m! - 1).padStart(2, '0')}`;
  }
  const keys = monthRange(start, endMonth);
  const snaps: Snapshot[] = [];
  const incs: Income[] = [];
  let a = 24000, ag = 1800, b = 15500, bg = 600, j = 3800, pen = 9000, car = -7200;
  keys.forEach((k, i) => {
    const mm = Number(k.slice(5));
    const bonusA = mm === 12 ? 2300 : mm === 7 ? 900 : 0;
    const netA = 2450 + (i > 12 ? 120 : 0);
    const netB = 1980 + (i > 8 ? 80 : 0);
    incs.push({ memberId: 'alex', month: k, net: netA, extra: bonusA || undefined });
    incs.push({ memberId: 'sam', month: k, net: netB });
    const wobble = Math.sin(i * 1.7) * 160;
    a += 620 + bonusA * 0.7 + wobble;
    ag += 140 + Math.sin(i) * 260;
    b += 430 + Math.cos(i * 1.3) * 140;
    bg += 60 + Math.cos(i) * 90;
    j += (mm === 8 ? -1400 : 90) + Math.sin(i * 2.1) * 120;
    pen += 210;
    car = Math.min(0, car + 300);
    snaps.push({ accountId: 'alex-broker', month: k, balance: Math.round(a + ag), unrealizedGain: Math.round(ag) });
    snaps.push({ accountId: 'sam-bank', month: k, balance: Math.round(b + bg), unrealizedGain: Math.round(bg) });
    snaps.push({ accountId: 'joint', month: k, balance: Math.round(j), allocations: { alex: 800, sam: 800 } });
    if (i % 3 === 0) snaps.push({ accountId: 'alex-pension', month: k, balance: Math.round(pen) });
    snaps.push({ accountId: 'car-loan', month: k, balance: Math.round(car) });
  });
  // the latest month is still being filled in
  const last = keys[keys.length - 1]!;
  const filtered = snaps.filter((s) => !(s.month === last && s.accountId === 'sam-bank'));
  void nextKey;
  return {
    version: 1,
    revision: 1,
    household: { name: 'Alex & Sam', currency: 'EUR', locale: 'en', createdAt: '2025-01-01T00:00:00Z' },
    members: [
      { id: 'alex', name: 'Alex', color: '#1f5fbf' },
      { id: 'sam', name: 'Sam', color: '#e2553a' },
    ],
    accounts: [
      { id: 'alex-broker', name: 'Broker', institution: 'Online broker', kind: 'investment', owners: [{ memberId: 'alex', share: 1 }], liquid: true },
      { id: 'sam-bank', name: 'Bank account', institution: 'Bank', kind: 'cash', owners: [{ memberId: 'sam', share: 1 }], liquid: true },
      { id: 'joint', name: 'Joint account', kind: 'cash', owners: [], liquid: true },
      { id: 'alex-pension', name: 'Pension fund', kind: 'pension', owners: [{ memberId: 'alex', share: 1 }], liquid: false },
      { id: 'car-loan', name: 'Car loan', kind: 'debt', owners: [{ memberId: 'alex', share: 0.5 }, { memberId: 'sam', share: 0.5 }], liquid: false },
    ],
    snapshots: filtered,
    incomes: incs,
    budget: [
      { id: 'rent', name: 'Rent', amount: 1050, frequency: 'monthly', ownerId: null, kind: 'expense', category: 'housing' },
      { id: 'utilities', name: 'Utilities', amount: 160, frequency: 'monthly', ownerId: null, kind: 'expense', category: 'utilities' },
      { id: 'phone-a', name: 'Phone', amount: 12, frequency: 'monthly', ownerId: 'alex', kind: 'expense' },
      { id: 'gym-s', name: 'Gym', amount: 45, frequency: 'monthly', ownerId: 'sam', kind: 'expense' },
      { id: 'car-ins', name: 'Car insurance', amount: 620, frequency: 'annual', dueMonth: 3, ownerId: null, kind: 'expense' },
      { id: 'holiday', name: 'Summer holiday', amount: 2400, frequency: 'annual', dueMonth: 8, ownerId: null, kind: 'expense' },
      { id: 'etf-plan', name: 'ETF plan', amount: 300, frequency: 'monthly', ownerId: 'alex', kind: 'saving' },
    ],
    settings: { ...DEFAULT_SETTINGS },
    scenarios: [
      {
        id: 'flat',
        name: 'Two-bedroom flat',
        price: 290000,
        familyHelp: 20000,
        rate: 0.032,
        agencyFee: 0.03,
        agencyFeeVat: 0.22,
        closingCosts: 9000,
        capitalUse: { alex: 0.8, sam: 0.7 },
        sharedCapitalUse: 1,
        durations: [20, 25, 30],
      },
    ],
  };
}
