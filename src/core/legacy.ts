/**
 * Importer for backups exported by the original "Conti congiunti" Claude
 * artifact (the two-person spreadsheet-style page this project grew out of).
 * Format: { saldo_mario, saldo_chiara, conto_comune, config: { parametri, spese_fisse, spese_annuali } }.
 */
import { DEFAULT_SETTINGS, emptyState, type State, type Snapshot, type Income, type BudgetItem } from './types.js';
import { isNum, isMonthKey } from './engine.js';

const MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const MONTHS_EN = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

type Rec = Record<string, Record<string, unknown>>;

export function isLegacyBackup(x: unknown): boolean {
  return !!x && typeof x === 'object' && ('saldo_mario' in x || 'saldo_chiara' in x || 'conto_comune' in x);
}

export function fromLegacy(raw: Record<string, unknown>, names: { a?: string; b?: string } = {}): State {
  const s = emptyState();
  const A = 'm_a';
  const B = 'm_b';
  const now = new Date().toISOString();
  s.household = { name: 'Household', currency: 'EUR', locale: 'it', createdAt: now };
  s.members = [
    { id: A, name: names.a ?? 'Mario', color: '#1f5fbf' },
    { id: B, name: names.b ?? 'Chiara', color: '#e2553a' },
  ];
  const cfg = (raw.config ?? {}) as Record<string, Record<string, unknown> | null>;
  const P = ((cfg.parametri as Record<string, unknown> | null)?.valori ?? {}) as Record<string, unknown>;
  const num = (x: unknown) => (isNum(x) ? x : undefined);

  s.settings = {
    ...DEFAULT_SETTINGS,
    capitalGainsTax: num(P.aliquota) ?? DEFAULT_SETTINGS.capitalGainsTax,
    emergencyMonths: num(P.mesiEmergenza) ?? DEFAULT_SETTINGS.emergencyMonths,
    maxPaymentRatio: num(P.sogliaRata) ?? DEFAULT_SETTINGS.maxPaymentRatio,
    referenceYear: num(P.annoMedie) ?? null,
  };

  const accA = 'acc_a_main';
  const accB = 'acc_b_main';
  const accJ = 'acc_joint';
  const accDep = 'acc_a_deposit';
  s.accounts = [
    { id: accA, name: 'Investimenti ' + s.members[0]!.name, kind: 'investment', owners: [{ memberId: A, share: 1 }], liquid: true },
    { id: accB, name: 'Conto ' + s.members[1]!.name, kind: 'investment', owners: [{ memberId: B, share: 1 }], liquid: true },
    { id: accJ, name: 'Conto comune', kind: 'cash', owners: [], liquid: true },
  ];

  const ma = (raw.saldo_mario ?? {}) as Rec;
  const ch = (raw.saldo_chiara ?? {}) as Rec;
  const cj = (raw.conto_comune ?? {}) as Rec;
  const snaps: Snapshot[] = [];
  const incs: Income[] = [];

  // joint account and A's deposit in it ("quotaMario", carried forward)
  const quotaAt = (key: string) => {
    const ks = Object.keys(cj).filter((k) => k <= key && isNum(cj[k]?.quotaMario)).sort();
    return ks.length ? (cj[ks[ks.length - 1]!]!.quotaMario as number) : 0;
  };
  for (const [k, d] of Object.entries(cj)) {
    if (!isMonthKey(k) || !d) continue;
    if (isNum(d.saldo)) {
      const q = quotaAt(k);
      snaps.push({ accountId: accJ, month: k, balance: d.saldo, allocations: q ? { [A]: q } : undefined, note: str(d.note) });
    }
  }

  const cauzione = num(P.cauzione) ?? 0;
  for (const [k, d] of Object.entries(ma)) {
    if (!isMonthKey(k) || !d) continue;
    if (isNum(d.fineco)) {
      snaps.push({ accountId: accA, month: k, balance: d.fineco, unrealizedGain: num(d.plus), note: str(d.note) });
    } else if (isNum(d.capitale)) {
      // manual capital included the joint-account deposit and the rent deposit: strip them out
      snaps.push({ accountId: accA, month: k, balance: d.capitale - quotaAt(k) - cauzione, note: str(d.note) });
    }
    if (isNum(d.stipendio)) incs.push({ memberId: A, month: k, net: d.stipendio, extra: num(d.extra) });
  }
  for (const [k, d] of Object.entries(ch)) {
    if (!isMonthKey(k) || !d) continue;
    if (isNum(d.conto)) snaps.push({ accountId: accB, month: k, balance: d.conto, unrealizedGain: num(d.plus), note: str(d.note) });
    if (isNum(d.entrate)) incs.push({ memberId: B, month: k, net: d.entrate });
  }
  if (cauzione) {
    s.accounts.push({ id: accDep, name: 'Deposito cauzionale', kind: 'other', owners: [{ memberId: A, share: 1 }], liquid: false });
    const first = snaps.map((x) => x.month).sort()[0];
    if (first) snaps.push({ accountId: accDep, month: first, balance: cauzione });
  }
  s.snapshots = snaps;
  s.incomes = incs;

  // budget
  const budget: BudgetItem[] = [];
  const fisse = (cfg.spese_fisse ?? {}) as Record<string, { voce?: string; importo?: number }[]>;
  let n = 0;
  const addList = (list: { voce?: string; importo?: number }[] | undefined, ownerId: string, kind: 'expense' | 'saving') => {
    for (const it of list ?? []) {
      if (!it || !isNum(it.importo)) continue;
      budget.push({ id: `b_${++n}`, name: it.voce || '—', amount: it.importo, frequency: 'monthly', ownerId, kind });
    }
  };
  addList(fisse.mario, A, 'expense');
  addList(fisse.chiara, B, 'expense');
  addList(fisse.pac, A, 'saving');
  const ann = ((cfg.spese_annuali ?? {}) as { voci?: { voce?: string; mese?: string; importo?: number; note?: string }[] }).voci ?? [];
  for (const it of ann) {
    if (!it || !isNum(it.importo)) continue;
    const m = (it.mese ?? '').toLowerCase().trim();
    const due = MESI.indexOf(m) >= 0 ? MESI.indexOf(m) + 1 : MONTHS_EN.indexOf(m) >= 0 ? MONTHS_EN.indexOf(m) + 1 : Number(m) || undefined;
    budget.push({ id: `b_${++n}`, name: it.voce || '—', amount: it.importo, frequency: 'annual', dueMonth: due, ownerId: A, kind: 'expense', note: it.note });
  }
  s.budget = budget;

  if (num(P.prezzoCasa)) {
    s.scenarios.push({
      id: 'home',
      name: 'Casa',
      price: P.prezzoCasa as number,
      familyHelp: num(P.contributoGenitori) ?? 0,
      rate: num(P.tan) ?? 0.035,
      agencyFee: num(P.provvigione) ?? 0,
      agencyFeeVat: num(P.ivaProvvigione) ?? 0,
      closingCosts: num(P.costiAccessori) ?? 0,
      capitalUse: { [A]: num(P.usoCapitaleMario) ?? 1, [B]: num(P.usoCapitaleChiara) ?? 1 },
      sharedCapitalUse: 1,
      durations: [20, 25, 30],
    });
  }
  return s;
}

function str(x: unknown) {
  return typeof x === 'string' && x ? x : undefined;
}
