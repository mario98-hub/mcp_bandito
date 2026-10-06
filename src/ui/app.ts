/**
 * Conti dashboard: an MCP App view. Runs inside the host's sandboxed iframe,
 * talks to the Conti server through the host (callServerTool), and asks
 * Claude for help through ui/message.
 *
 * The calculation engine is bundled here too, so what-if inputs (home price,
 * mortgage rate, purchase…) recompute instantly without a round trip.
 */
import { App } from '@modelcontextprotocol/ext-apps';
import {
  compute,
  isNum,
  onboardingNext,
  simulateHome,
  simulatePurchase,
  nextKey,
  prevKey,
  type Computed,
  type HomeResult,
  type OnboardingNext,
  type PurchaseInput,
} from '../core/engine.js';
import { SHARED, emptyState, type HomeScenario, type Locale, type State, type Account } from '../core/types.js';
import { t, money, pct, num, monthLabel, MONTH_NAMES, type Strings } from '../core/i18n.js';
import { demoState } from '../core/demo.js';

type Tab = 'overview' | 'month' | 'history' | 'budget' | 'home' | 'purchase' | 'settings';
const TABS: Tab[] = ['overview', 'month', 'history', 'budget', 'home', 'purchase'];

interface ViewPayload {
  today: string;
  state: State;
}

const S = {
  app: null as App | null,
  demo: false,
  state: null as State | null,
  today: '',
  tab: 'overview' as Tab,
  month: '' as string,
  histOwner: 'total',
  monthDraft: {} as Record<string, string>,
  homeDraft: null as HomeScenario | null,
  homeId: null as string | null,
  purchase: { name: '', price: 15000, monthlyRunningCost: 0, expectedReturn: 0.03 } as PurchaseInput,
  openMetrics: new Set<string>(),
  busy: false,
  hover: -1,
  budgetForm: false,
  canMessage: false,
  canDownload: false,
  fullscreen: false,
  canFullscreen: false,
  hostLocale: 'en' as Locale,
};

const $ = (id: string) => document.getElementById(id)!;
const root = $('root');
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const L = (): Locale => S.state?.household?.locale ?? S.hostLocale;
const T = (): Strings => t(L());
const cur = () => S.state?.household?.currency ?? 'EUR';
const M = (v: number | null | undefined, sign = false) => money(v, cur(), L(), sign);
const P = (v: number | null | undefined, d = 0) => pct(v, L(), d);

function ownerColor(id: string) {
  if (id === SHARED) return 'var(--shared)';
  const i = S.state?.members.findIndex((m) => m.id === id) ?? 0;
  return `var(--c${Math.max(0, i) % 6})`;
}
function ownerName(id: string) {
  if (id === 'total') return T().household;
  if (id === SHARED) return T().shared;
  return S.state?.members.find((m) => m.id === id)?.name ?? id;
}
function accountColor(a: Account) {
  if (!a.owners.length) return ownerColor(SHARED);
  return a.owners.length === 1 ? ownerColor(a.owners[0]!.memberId) : `linear-gradient(${a.owners.map((o) => ownerColor(o.memberId)).join(',')})`;
}

let toastTimer = 0;
function toast(msg: string) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), 2600);
}

// ------------------------------------------------------------------ data

async function callTool(name: string, args: Record<string, unknown>) {
  if (!S.app) throw new Error('offline');
  const r = await S.app.callServerTool({ name, arguments: args });
  if (r.isError) throw new Error((r.content?.[0] as { text?: string } | undefined)?.text ?? 'Error');
  return r;
}

async function refresh() {
  if (S.demo) return render();
  try {
    const r = await callTool('conti_app_state', {});
    const v = (r.structuredContent as { view?: ViewPayload } | undefined)?.view;
    if (v) {
      S.state = v.state;
      S.today = v.today;
    }
  } catch (e) {
    console.error(e);
  }
  render();
}

async function askClaude(text: string) {
  if (S.app && S.canMessage) {
    try {
      await S.app.sendMessage({ role: 'user', content: [{ type: 'text', text }] });
      return;
    } catch (e) {
      console.error(e);
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    toast(L() === 'it' ? 'Copiato: incollalo nella chat' : 'Copied: paste it in the chat');
  } catch {
    toast(text);
  }
}

function tellModel(text: string) {
  if (!S.app || S.demo) return;
  S.app.updateModelContext({ content: [{ type: 'text', text }] }).catch(() => undefined);
}

// ------------------------------------------------------------------ render

let C: Computed;

function render() {
  const st = S.state;
  if (!st) {
    root.innerHTML = '<main><p class="muted">…</p></main>';
    return;
  }
  C = compute(st, { today: S.today });
  if (!S.month) S.month = defaultMonth();
  document.documentElement.lang = L();
  const setUp = !!st.household && st.members.length > 0;
  const body = !setUp ? onboarding() : renderTab();
  root.innerHTML = `${band(setUp)}<main id="main">${S.demo ? `<div class="notice">${esc(T().demo)}</div>` : ''}${body}</main>
  <div class="foot"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>${esc(T().privacy)}</div>`;
  afterRender();
}

const LOGO = `<svg class="logo" viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="13" width="5" height="9" rx="1" fill="var(--c0)"/><rect x="9.5" y="8" width="5" height="14" rx="1" fill="var(--c1)"/><rect x="17" y="3" width="5" height="19" rx="1" fill="var(--accent)"/></svg>`;
const ICON_FS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>`;
const ICON_GEAR = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/></svg>`;
const ICON_CHAT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M4 5h16v11H9l-5 4z"/></svg>`;

function band(setUp: boolean) {
  const st = S.state!;
  const tabs = setUp
    ? `<nav class="tabs" role="tablist">${TABS.map((id) => {
        const dot = id === 'month' && C.statusOf(S.today).overall !== 'ok' ? '<span class="dot" aria-hidden="true"></span>' : '';
        return `<button class="tab" role="tab" data-tab="${id}" aria-selected="${S.tab === id}">${esc(T().tabs[id])}${dot}</button>`;
      }).join('')}</nav>`
    : '<div style="height:12px"></div>';
  return `<header class="band">
    <div class="band-row">
      <h1>${LOGO}<span>Conti</span><span class="hh">${esc(st.household?.name ?? '')}</span></h1>
      <div class="band-actions">
        ${S.canFullscreen ? `<button class="ibtn" data-act="fullscreen" aria-pressed="${S.fullscreen}" title="Fullscreen">${ICON_FS}</button>` : ''}
        ${setUp ? `<button class="ibtn" data-tab="settings" aria-pressed="${S.tab === 'settings'}" title="${esc(T().tabs.settings)}">${ICON_GEAR}</button>` : ''}
      </div>
    </div>
    ${tabs}
    ${setUp && S.tab === 'overview' ? hero() : ''}
  </header>`;
}

function onboarding() {
  const O = T().onboarding;
  const labels = T().onboardingSteps;
  const o = onboardingNext(S.state!);
  const optional = L() === 'it' ? 'facoltativo' : 'optional';
  const items = o.steps
    .map((s) => {
      const isNext = o.next?.id === s.id;
      return `<li class="ob-step${s.done ? ' done' : ''}${isNext ? ' next' : ''}">
        <span class="ob-mark" aria-hidden="true">${s.done ? '✓' : s.n}</span>
        <span class="ob-label">${esc(labels[s.id])}${s.optional ? ` <small class="muted">(${esc(optional)})</small>` : ''}</span>
      </li>`;
    })
    .join('');
  const done = o.steps.filter((s) => s.done).length;
  const fresh = done === 0;
  const btn = fresh ? O.cta : L() === 'it' ? 'Continua con Claude' : 'Continue with Claude';
  const prompt = fresh ? O.ctaPrompt : onboardingPrompt(o);
  return `<section class="empty-state onboarding"><h2>${esc(O.title)}</h2><p>${esc(O.body)}</p>
  <ol class="ob-steps" aria-label="${esc(L() === 'it' ? 'Passi di configurazione' : 'Setup steps')}">${items}</ol>
  <p class="sub">${done}/${o.steps.length} ${esc(L() === 'it' ? 'completati' : 'done')}</p>
  <button class="btn accent" data-ask="${esc(prompt)}">${ICON_CHAT}${esc(btn)}</button></section>`;
}

function onboardingPrompt(o: OnboardingNext) {
  if (!o.next) return T().onboarding.ctaPrompt;
  const label = T().onboardingSteps[o.next.id];
  return L() === 'it'
    ? `Continuiamo a configurare Conti. Il prossimo passo è "${label}". Guidami tu, una domanda alla volta.`
    : `Let's continue setting up Conti. The next step is "${label}". Guide me, one question at a time.`;
}

function renderTab() {
  switch (S.tab) {
    case 'month': return monthTab();
    case 'history': return historyTab();
    case 'budget': return budgetTab();
    case 'home': return homeTab();
    case 'purchase': return purchaseTab();
    case 'settings': return settingsTab();
    default: return overviewTab();
  }
}

// ------------------------------------------------------------------ overview

function hero() {
  const nw = C.netWorth;
  if (!nw.asOf) return `<div class="hero"><div class="label">${esc(T().netWorth)}</div><div class="big">—</div></div>`;
  const owners = C.owners.map((o) => ({ ...o, v: nw.byOwner[o.id]?.realizable ?? 0 })).filter((o) => Math.abs(o.v) > 0.5);
  const pos = owners.filter((o) => o.v > 0);
  const prev = C.rows[C.rows.length - 2];
  const delta = prev ? nw.total.realizable - prev.total.realizable : null;
  const ytdBase = [...C.rows].reverse().find((r) => r.month.endsWith('-12') && r.month < nw.asOf!);
  const ytd = ytdBase ? nw.total.realizable - ytdBase.total.realizable : null;
  return `<div class="hero">
    <div class="label"><span>${esc(T().netWorth)}</span><span>· ${esc(T().asOf)} ${esc(monthLabel(nw.asOf, L()))}</span></div>
    <div class="big" title="${esc(T().netWorthHint)}">${M(nw.total.realizable)}</div>
    ${isNum(delta) ? `<div class="delta"><b>${M(delta, true)}</b> ${L() === 'it' ? 'sul mese prima' : 'vs previous month'}${isNum(ytd) ? ` · <b>${M(ytd, true)}</b> ${L() === 'it' ? 'da inizio anno' : 'year to date'}` : ''}</div>` : ''}
    <div class="sbar" aria-hidden="true">${pos.map((o) => `<span style="flex-grow:${o.v};background:${ownerColor(o.id)}"></span>`).join('')}</div>
    <div class="legend">${owners.map((o) => `<div style="--sw:${ownerColor(o.id)}"><div class="who">${esc(ownerName(o.id))}</div><div class="val">${M(o.v)}</div></div>`).join('')}
      ${nw.debts ? `<div style="--sw:var(--neg)"><div class="who">${L() === 'it' ? 'di cui debiti' : 'incl. debts'}</div><div class="val">${M(nw.debts)}</div></div>` : ''}</div>
  </div>`;
}

function monthStatusBlock() {
  const st = S.state!;
  const s = C.statusOf(S.today);
  const missing = [
    ...s.missingAccounts.map((id) => st.accounts.find((a) => a.id === id)?.name ?? id),
    ...s.missingIncomes.map((id) => `${T().income} ${ownerName(id)}`),
  ];
  const n = missing.length;
  return `<section><div class="row"><h2 style="margin:0">${esc(monthLabel(S.today, L()))}</h2><span class="chip ${s.overall === 'ok' ? 'ok-state' : s.overall}">${esc(T().status[s.overall])}</span></div>
    <p class="sub" style="margin-top:6px">${esc(n ? T().monthTodo(n) : T().monthDone)}</p>
    ${n ? `<div class="status-list">${missing.map((m) => `<div class="it"><span>${esc(m)}</span><span class="chip missing">${esc(T().status.missing)}</span></div>`).join('')}</div>
    <div class="row"><button class="btn accent" data-ask="${esc(T().askClaudeFillPrompt(monthLabel(S.today, L())))}">${ICON_CHAT}${esc(T().askClaudeFill)}</button>
    <button class="btn" data-tab="month" data-month="${S.today}">${L() === 'it' ? 'Inserisci a mano' : 'Enter manually'}</button></div>` : ''}
  </section>`;
}

function flowsBlock() {
  const f = C.flows;
  if (!f.household && !Object.values(f.perMember).some(Boolean)) return '';
  const cols = [...S.state!.members.map((m) => ({ id: m.id, y: f.perMember[m.id] })), ...(S.state!.members.length > 1 ? [{ id: 'total', y: f.household }] : [])];
  const row = (label: string, get: (y: NonNullable<(typeof cols)[0]['y']>) => string) =>
    `<tr><td>${esc(label)}</td>${cols.map((c) => `<td>${c.y ? get(c.y) : '—'}</td>`).join('')}</tr>`;
  return `<section><h2>${esc(T().savings)} · ${f.year ?? ''}</h2>
    <p class="sub">${esc(T().avgPerMonth)}${C.refYearAuto ? '' : ' ·  ' + esc(T().settings.referenceYear)}</p>
    <div class="card scroll"><table>
      <thead><tr><th></th>${cols.map((c) => `<th><span class="sw" style="background:${c.id === 'total' ? 'var(--ink)' : ownerColor(c.id)}"></span>${esc(ownerName(c.id))}</th>`).join('')}</tr></thead>
      <tbody>
      ${row(T().income, (y) => M(y.avgIncome))}
      ${row(T().spending, (y) => M(y.avgSpending))}
      ${row(T().savings, (y) => `<b>${M(y.avgSavings)}</b>`)}
      ${row(T().savingsRate, (y) => `<b>${P(y.savingsRate)}</b>`)}
      </tbody></table></div></section>`;
}

function chartBlock() {
  const rows = C.rows.slice(-36);
  if (rows.length < 2) return '';
  return `<section><h2>${esc(T().netWorth)}</h2><div class="readout" id="readout">&nbsp;</div><div class="chart" id="chart"></div></section>`;
}

function drawChart() {
  const box = document.getElementById('chart');
  if (!box) return;
  const rows = C.rows.slice(-36);
  const owners = C.owners.map((o) => o.id);
  const W = Math.max(300, Math.round(box.clientWidth || 600));
  const H = W < 520 ? 190 : 230;
  const pad = { l: 46, r: 6, t: 8, b: 22 };
  const vals = rows.map((r) => owners.reduce((s, o) => s + Math.max(0, r.byOwner[o]?.realizable ?? 0), 0));
  const negs = rows.map((r) => r.debts);
  const max = Math.max(1, ...vals);
  const min = Math.min(0, ...negs);
  const step = niceStep(max / 4);
  const top = Math.ceil(max / step) * step;
  const bot = min < 0 ? min * 1.15 : 0;
  const y = (v: number) => pad.t + ((top - v) / (top - bot || 1)) * (H - pad.t - pad.b);
  const bw = (W - pad.l - pad.r) / rows.length;
  let g = '';
  for (let v = Math.ceil(bot / step) * step || 0; v <= top + 0.001; v += step) {
    g += `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/><text class="tick" x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${compact(v)}</text>`;
  }
  let bars = '';
  rows.forEach((r, i) => {
    const x = pad.l + i * bw + bw * 0.14;
    const w = bw * 0.72;
    let acc = 0;
    for (const o of owners) {
      const v = Math.max(0, r.byOwner[o]?.realizable ?? 0);
      if (!v) continue;
      bars += `<rect x="${x}" y="${y(acc + v)}" width="${w}" height="${Math.max(0, y(acc) - y(acc + v) - 1)}" fill="${ownerColor(o)}" rx="1.5"/>`;
      acc += v;
    }
    if (r.debts < 0) bars += `<rect x="${x}" y="${y(0)}" width="${w}" height="${y(r.debts) - y(0)}" fill="var(--neg)" opacity=".55" rx="1.5"/>`;
    const lab = r.month.endsWith('-01') || i === 0 ? r.month.slice(0, 4) : '';
    if (lab) g += `<text class="tick" x="${x}" y="${H - 6}">${lab}</text>`;
  });
  const hl = S.hover >= 0 && S.hover < rows.length ? `<rect class="hl" x="${pad.l + S.hover * bw}" y="${pad.t}" width="${bw}" height="${H - pad.t - pad.b}"/>` : '';
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(T().netWorth)}">${g}${hl}${bars}<rect id="hit" x="${pad.l}" y="0" width="${W - pad.l - pad.r}" height="${H}" fill="transparent"/></svg>`;
  const hit = box.querySelector('#hit') as SVGRectElement;
  const move = (ev: PointerEvent) => {
    const rect = (box.firstElementChild as SVGSVGElement).getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W - pad.l;
    const i = Math.max(0, Math.min(rows.length - 1, Math.floor(px / bw)));
    if (i !== S.hover) {
      S.hover = i;
      drawChart();
    }
    const r = rows[i]!;
    $('readout').innerHTML = `<b>${esc(monthLabel(r.month, L()))}</b> · ${M(r.total.realizable)} · ${esc(T().savings)} <b>${M(r.savings.total, true)}</b>`;
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerleave', () => {
    S.hover = -1;
    drawChart();
    $('readout').innerHTML = '&nbsp;';
  });
}
function niceStep(x: number) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(1, x))));
  const f = x / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}
function compact(v: number) {
  const a = Math.abs(v);
  const s = a >= 1e6 ? `${num(v / 1e6, L(), 1)}M` : a >= 1e3 ? `${num(v / 1e3, L(), 0)}k` : num(v, L(), 0);
  return s.replace('-', '−');
}

function healthBlock() {
  const H = T().health;
  const fmt = (id: string, v: number | null) => {
    if (!isNum(v)) return '—';
    if (id === 'savingsRate' || id === 'fixedCosts' || id === 'debtRatio') return P(v);
    return num(v, L(), id === 'freshness' ? 0 : 1);
  };
  return `<section><div class="row"><h2 style="margin:0">${esc(H.title)}</h2><span class="spacer"></span>
    <button class="btn small" data-ask="${esc(T().askClaudeExplainPrompt)}">${ICON_CHAT}${esc(T().askClaudeExplain)}</button></div>
    <div class="health" style="margin-top:12px">${C.health
      .map((m) => {
        const h = H[m.id];
        const open = S.openMetrics.has(m.id);
        return `<button class="metric" data-metric="${m.id}" aria-expanded="${open}">
          <span class="row" style="justify-content:space-between;width:100%"><span class="mn">${esc(h.name)}</span><span class="chip ${m.status}">${esc(T().hs[m.status])}</span></span>
          <span class="mv">${fmt(m.id, m.value)} <small class="mn unit">${m.id === 'savingsRate' || m.id === 'fixedCosts' || m.id === 'debtRatio' ? '' : m.value === 1 ? esc(L() === 'it' ? h.unit.replace('mesi', 'mese') : h.unit.replace('months', 'month')) : esc(h.unit)}</small></span>
          <span class="why">${esc(h.why)}</span></button>`;
      })
      .join('')}</div></section>`;
}

function overviewTab() {
  if (!C.latestMonth)
    return `${monthStatusBlock()}<section><p class="muted">${esc(T().nothingYet)}</p></section>`;
  return monthStatusBlock() + flowsBlock() + chartBlock() + healthBlock();
}

// ------------------------------------------------------------------ month

function defaultMonth() {
  const s = C.statusOf(S.today);
  if (s.overall !== 'ok') return S.today;
  return S.today;
}

function monthOptions() {
  const set = new Set<string>([...C.months, S.today, nextKey(S.today)]);
  for (let k = S.today, i = 0; i < 3; i++) set.add((k = prevKey(k)));
  return [...set].sort().reverse();
}

function snapOf(accId: string, month: string) {
  return S.state!.snapshots.find((s) => s.accountId === accId && s.month === month);
}
function lastSnap(accId: string, month: string) {
  return [...S.state!.snapshots].filter((s) => s.accountId === accId && s.month < month).sort((a, b) => b.month.localeCompare(a.month))[0];
}
function incOf(memId: string, month: string) {
  return S.state!.incomes.find((s) => s.memberId === memId && s.month === month);
}
function draftVal(key: string, stored: number | undefined) {
  if (key in S.monthDraft) return S.monthDraft[key]!;
  return isNum(stored) ? String(stored).replace('.', L() === 'it' ? ',' : '.') : '';
}
/**
 * Accepts "27350", "27.350", "27,350", "27.350,50", "27,350.50", "1.234.567", "−900".
 * Both separators present → the last one is the decimal mark. One separator used
 * once and followed by exactly three digits → thousands; otherwise decimal.
 */
export function parseNum(s: string, decimalOnly = false): number | null {
  let v = s.trim().replace(/[€$£\s\u00a0']/g, '').replace(/\u2212/g, '-');
  if (!v) return null;
  const dots = (v.match(/\./g) ?? []).length;
  const commas = (v.match(/,/g) ?? []).length;
  if (dots && commas) {
    const dec = v.lastIndexOf('.') > v.lastIndexOf(',') ? '.' : ',';
    v = v.split(dec === '.' ? ',' : '.').join('').replace(dec, '.');
  } else if (dots + commas > 0) {
    const sep = dots ? '.' : ',';
    const parts = v.split(sep);
    if (parts.length > 2 || (!decimalOnly && parts[parts.length - 1]!.length === 3)) v = parts.join('');
    else v = parts.join('.');
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function monthTab() {
  const st = S.state!;
  const m = S.month;
  const s = C.statusOf(m);
  const accs = st.accounts.filter((a) => !a.archived);
  const field = (key: string, label: string, stored: number | undefined, placeholder?: number, hint?: string) => {
    const v = draftVal(key, stored);
    const bad = v && Number.isNaN(parseNum(v));
    return `<div class="field"><label for="f-${key}">${esc(label)}</label><input id="f-${key}" data-draft="${key}" inputmode="decimal" autocomplete="off" value="${esc(v)}" placeholder="${isNum(placeholder) ? esc(num(placeholder, L(), 0)) : ''}" aria-invalid="${bad ? 'true' : 'false'}">${hint ? `<div class="hint">${esc(hint)}</div>` : ''}</div>`;
  };
  const cards = accs
    .map((a) => {
      const sn = snapOf(a.id, m);
      const prev = lastSnap(a.id, m);
      const inv = a.kind === 'investment' || a.kind === 'pension';
      const owners = a.owners.length ? a.owners.map((o) => `${ownerName(o.memberId)}${o.share < 1 ? ' ' + P(o.share) : ''}`).join(' + ') : T().shared;
      return `<div class="acct" style="--sw:${accountColor(a)}"><div class="acct-head"><span><b>${esc(a.name)}</b> <small>${esc([a.institution, T().kinds[a.kind], owners].filter(Boolean).join(' · '))}</small></span>
        <span class="chip ${sn ? 'ok-state' : 'missing'}">${esc(sn ? T().status.ok : T().status.missing)}</span></div>
        <div class="fields">${field(`b|${a.id}`, T().balance + (a.kind === 'debt' ? ' (−)' : ''), sn?.balance, prev?.balance, prev && !sn ? `${monthLabel(prev.month, L())}: ${M(prev.balance)}` : undefined)}
        ${inv ? field(`g|${a.id}`, T().gain, sn?.unrealizedGain, prev?.unrealizedGain) : ''}</div></div>`;
    })
    .join('');
  const incomes = st.members
    .map((mem) => {
      const i = incOf(mem.id, m);
      return `<div class="acct" style="--sw:${ownerColor(mem.id)}"><div class="acct-head"><span><b>${esc(T().income)} · ${esc(mem.name)}</b></span><span class="chip ${i ? 'ok-state' : 'missing'}">${esc(i ? T().status.ok : T().status.missing)}</span></div>
      <div class="fields">${field(`n|${mem.id}`, T().net, i?.net, incOf(mem.id, prevKey(m))?.net)}${field(`e|${mem.id}`, T().extra, i?.extra)}</div></div>`;
    })
    .join('');
  const dirty = Object.keys(S.monthDraft).length > 0;
  return `<section><div class="row"><select class="month" id="month-sel" aria-label="${esc(T().month)}">${monthOptions().map((k) => `<option value="${k}" ${k === m ? 'selected' : ''}>${esc(monthLabel(k, L()))}</option>`).join('')}</select>
    <span class="chip ${s.overall === 'ok' ? 'ok-state' : s.overall}">${esc(T().status[s.overall])}</span><span class="spacer"></span>
    <button class="btn small" data-ask="${esc(T().askClaudeFillPrompt(monthLabel(m, L())))}">${ICON_CHAT}${esc(T().askClaudeFill)}</button></div>
    <p class="sub" style="margin-top:8px">${L() === 'it' ? 'Saldi a fine mese. Per gli investimenti indica anche la plusvalenza latente: serve a calcolare il patrimonio al netto delle tasse.' : 'Month-end balances. For investments also enter the unrealized gain: it is used to compute wealth after tax.'}</p>
    <h3>${esc(T().accounts)}</h3>${cards || `<p class="muted">${esc(T().nothingYet)}</p>`}
    <h3 style="margin-top:18px">${esc(T().income)}</h3>${incomes}
    ${dirty ? `<div class="savebar"><span>${L() === 'it' ? 'Modifiche non salvate' : 'Unsaved changes'}</span><span class="row"><button class="btn small ghost" style="color:var(--on-band)" data-act="discard">${esc(T().cancel)}</button><button class="btn accent" data-act="save-month" ${S.busy ? 'disabled' : ''}>${esc(S.busy ? T().saving : T().save)}</button></span></div>` : ''}
  </section>`;
}

async function saveMonth() {
  const st = S.state!;
  const m = S.month;
  const balances: Record<string, { account: string; balance: number; unrealizedGain?: number }> = {};
  const incomes: Record<string, { member: string; net: number; extra?: number }> = {};
  const toDelete = { accounts: [] as string[], members: [] as string[] };
  for (const [k, raw] of Object.entries(S.monthDraft)) {
    const [kind, id] = k.split('|') as [string, string];
    const v = parseNum(raw);
    if (Number.isNaN(v)) return toast(L() === 'it' ? 'Controlla i numeri evidenziati' : 'Check the highlighted numbers');
    if (kind === 'b' || kind === 'g') {
      const sn = snapOf(id, m);
      const cur = balances[id] ?? { account: id, balance: sn?.balance ?? NaN, unrealizedGain: sn?.unrealizedGain };
      if (kind === 'b') {
        if (v === null) toDelete.accounts.push(id);
        else cur.balance = v;
      } else cur.unrealizedGain = v ?? undefined;
      balances[id] = cur;
    } else {
      const i = incOf(id, m);
      const cur = incomes[id] ?? { member: id, net: i?.net ?? NaN, extra: i?.extra };
      if (kind === 'n') {
        if (v === null) toDelete.members.push(id);
        else cur.net = v;
      } else cur.extra = v ?? undefined;
      incomes[id] = cur;
    }
  }
  const bl = Object.values(balances).filter((b) => isNum(b.balance) && !toDelete.accounts.includes(b.account));
  const il = Object.values(incomes).filter((i) => isNum(i.net) && !toDelete.members.includes(i.member));
  S.busy = true;
  render();
  try {
    if (S.demo) {
      for (const b of bl) {
        const acc = st.accounts.find((a) => a.id === b.account)!;
        const bal = acc.kind === 'debt' && b.balance > 0 ? -b.balance : b.balance;
        st.snapshots = st.snapshots.filter((s) => !(s.accountId === b.account && s.month === m));
        st.snapshots.push({ accountId: b.account, month: m, balance: bal, unrealizedGain: b.unrealizedGain });
      }
      for (const i of il) {
        st.incomes = st.incomes.filter((s) => !(s.memberId === i.member && s.month === m));
        st.incomes.push({ memberId: i.member, month: m, net: i.net, extra: i.extra });
      }
      st.snapshots = st.snapshots.filter((s) => !(s.month === m && toDelete.accounts.includes(s.accountId)));
      st.incomes = st.incomes.filter((s) => !(s.month === m && toDelete.members.includes(s.memberId)));
    } else {
      if (bl.length || il.length) await callTool('conti_record_month', { month: m, balances: bl, incomes: il });
      if (toDelete.accounts.length || toDelete.members.length) await callTool('conti_delete_entries', { month: m, accounts: toDelete.accounts, members: toDelete.members });
      await refresh();
      tellModel(`The user updated ${m} in the Conti dashboard (${bl.length} balances, ${il.length} incomes).`);
    }
    S.monthDraft = {};
    toast(T().saved);
  } catch (e) {
    toast(String((e as Error).message ?? e));
  } finally {
    S.busy = false;
    render();
  }
}

// ------------------------------------------------------------------ history

function historyTab() {
  const owners = ['total', ...C.owners.map((o) => o.id)];
  const o = owners.includes(S.histOwner) ? S.histOwner : 'total';
  const isMember = S.state!.members.some((m) => m.id === o);
  const rows = [...C.rows].reverse();
  const years = [...new Set(rows.map((r) => r.month.slice(0, 4)))];
  const showInc = o === 'total' || isMember;
  let body = '';
  for (const y of years) {
    const yr = C.years.find((x) => x.year === Number(y) && x.owner === o);
    if (yr) body += `<tr class="yr"><td>${y}</td><td>${M(yr.endRealizable)}</td>${showInc ? `<td>${M(yr.avgIncome)}</td><td>${M(yr.avgSpending)}</td>` : ''}<td>${M(yr.avgSavings, true)}</td>${showInc ? `<td>${P(yr.savingsRate)}</td>` : ''}</tr>`;
    for (const r of rows.filter((x) => x.month.startsWith(y))) {
      const nw = o === 'total' ? r.total.realizable : r.byOwner[o]?.realizable;
      const inc = o === 'total' ? (S.state!.members.every((m) => r.income[m.id]) ? r.incomeTotal : null) : r.income[o]?.total ?? null;
      const sv = o === 'total' ? r.savings.total : r.savings[o] ?? null;
      const sp = o === 'total' ? r.spending.total : r.spending[o] ?? null;
      const rate = isNum(sv) && isNum(inc) && inc ? sv / inc : null;
      body += `<tr><td><button class="btn ghost small" style="padding:0" data-tab="month" data-month="${r.month}">${esc(MONTH_NAMES[L()][Number(r.month.slice(5)) - 1])}</button> ${r.status.overall !== 'ok' ? `<span class="chip ${r.status.overall}" title="${esc(T().carried)}">${esc(T().status[r.status.overall])}</span>` : ''}</td>
        <td>${M(nw)}</td>${showInc ? `<td>${M(inc)}</td><td>${M(sp)}</td>` : ''}<td class="${isNum(sv) && sv < 0 ? 'neg' : ''}">${M(sv, true)}</td>${showInc ? `<td>${P(rate)}</td>` : ''}</tr>`;
    }
  }
  return `<section><h2>${esc(T().tabs.history)}</h2>
    <div class="row" role="group" style="margin-bottom:12px">${owners.map((id) => `<button class="btn small ${id === o ? 'primary' : ''}" data-hist="${id}"><span class="sw" style="background:${id === 'total' ? 'var(--ink)' : ownerColor(id)}"></span>${esc(ownerName(id))}</button>`).join('')}</div>
    <div class="scroll"><table><thead><tr><th>${esc(T().month)}</th><th>${esc(T().netWorth)}</th>${showInc ? `<th>${esc(T().income)}</th><th>${esc(T().spending)}</th>` : ''}<th>${esc(T().savings)}</th>${showInc ? `<th>%</th>` : ''}</tr></thead><tbody>${body}</tbody></table></div>
    <p class="sub" style="margin-top:10px">${L() === 'it' ? 'Riga dell’anno: patrimonio a fine anno e medie mensili. Risparmio = variazione del capitale investito (senza le plusvalenze); spese = entrate − risparmio.' : 'Year row: year-end net worth and monthly averages. Savings = change in invested capital (gains excluded); spending = income − savings.'}</p></section>`;
}

// ------------------------------------------------------------------ budget

function budgetTab() {
  const st = S.state!;
  const b = C.budget;
  const groups = [...st.members.map((m) => m.id), SHARED];
  const list = (oid: string) => {
    const items = st.budget.filter((x) => (x.ownerId && st.members.some((m) => m.id === x.ownerId) ? x.ownerId : SHARED) === oid);
    if (!items.length) return '';
    return `<div class="card"><h3><span class="sw" style="background:${ownerColor(oid)}"></span>${esc(ownerName(oid))}</h3><div class="blist">${items
      .map(
        (x) => `<div class="bitem"><span>${esc(x.name)}<small>${esc(x.frequency === 'annual' ? `${T().annual}${x.dueMonth ? ' · ' + MONTH_NAMES[L()][x.dueMonth - 1] : ''}` : T().monthly)}${x.kind === 'saving' ? ' · ' + esc(T().plannedSaving) : ''}</small></span>
        <span class="amt">${M(x.amount)}${x.frequency === 'annual' ? `<small>${M(x.amount / 12)}/${L() === 'it' ? 'mese' : 'mo'}</small>` : ''}</span><button class="xbtn" data-del-budget="${esc(x.id)}" aria-label="${esc(T().delete)} ${esc(x.name)}">×</button></div>`,
      )
      .join('')}</div></div>`;
  };
  const maxDue = Math.max(1, ...Object.values(b.byMonthDue));
  const hh = b.household;
  const form = S.budgetForm
    ? `<div class="card" style="margin-top:14px"><h3>${esc(T().add)}</h3><div class="fields">
      <div class="field"><label>${esc(T().name)}</label><input id="bf-name"></div>
      <div class="field"><label>${esc(T().amount)}</label><input id="bf-amount" inputmode="decimal"></div>
      <div class="field"><label>${esc(T().frequency)}</label><select id="bf-freq"><option value="monthly">${esc(T().monthly)}</option><option value="annual">${esc(T().annual)}</option></select></div>
      <div class="field"><label>${esc(T().dueMonth)}</label><select id="bf-due"><option value="">—</option>${MONTH_NAMES[L()].map((n, i) => `<option value="${i + 1}">${esc(n)}</option>`).join('')}</select></div>
      <div class="field"><label>${esc(T().owner)}</label><select id="bf-owner">${groups.map((g) => `<option value="${g}">${esc(ownerName(g))}</option>`).join('')}</select></div>
      <div class="field"><label>${esc(T().kind)}</label><select id="bf-kind"><option value="expense">${esc(T().expense)}</option><option value="saving">${esc(T().plannedSaving)}</option></select></div>
      </div><div class="row" style="margin-top:12px"><button class="btn primary" data-act="budget-save">${esc(T().save)}</button><button class="btn ghost" data-act="budget-cancel">${esc(T().cancel)}</button></div></div>`
    : `<button class="btn" style="margin-top:14px" data-act="budget-add">+ ${esc(T().add)}</button>`;
  return `<section><h2>${esc(T().tabs.budget)}</h2>
    <p class="sub">${L() === 'it' ? 'Le spese fisse che conosci in anticipo. Confrontate con le spese reali (misurate dai saldi) mostrano quanto vale la parte variabile.' : 'Fixed costs you know in advance. Compared with real spending (measured from balances) they show how big the variable part is.'}</p>
    <div class="grid2">
      <div class="card"><dl class="kv">
        <dt>${L() === 'it' ? 'Spese fisse mensili' : 'Monthly fixed costs'}</dt><dd>${M(b.monthlyExpenses)}</dd>
        <dt>${L() === 'it' ? 'Spese annuali, al mese' : 'Yearly costs, per month'}<small>${M(b.annualExpenses)} / ${L() === 'it' ? 'anno' : 'year'}</small></dt><dd>${M(b.annualAsMonthly)}</dd>
        <dt class="total">${L() === 'it' ? 'Totale fisso' : 'Total fixed'}</dt><dd class="total">${M(b.fixedMonthlyEquivalent)}</dd>
        <dt>${esc(T().plannedSaving)}</dt><dd>${M(b.plannedSavings)}</dd>
      </dl></div>
      <div class="card"><dl class="kv">
        <dt>${esc(T().income)} <small>${esc(T().avgPerMonth)} ${C.flows.year ?? ''}</small></dt><dd>${M(hh.income)}</dd>
        <dt>${L() === 'it' ? 'Spese reali' : 'Actual spending'}</dt><dd>${M(hh.actualSpending)}</dd>
        <dt>${L() === 'it' ? 'di cui variabili' : 'of which variable'}<small>${L() === 'it' ? 'spesa, svago, imprevisti…' : 'groceries, leisure, surprises…'}</small></dt><dd>${M(hh.variableSpending)}</dd>
        <dt class="total">${esc(T().savings)}</dt><dd class="total">${M(hh.actualSavings)}</dd>
      </dl></div>
    </div>
    ${b.annualExpenses ? `<div class="card" style="margin-top:14px"><h3>${L() === 'it' ? 'Quando arrivano le spese annuali' : 'When yearly costs hit'}</h3>
      <div class="months12">${Array.from({ length: 12 }, (_, i) => `<div title="${esc(MONTH_NAMES[L()][i])}: ${M(b.byMonthDue[i + 1] ?? 0)}" style="height:${((b.byMonthDue[i + 1] ?? 0) / maxDue) * 100}%"></div>`).join('')}</div>
      <div class="months12-l">${MONTH_NAMES[L()].map((n) => `<span>${esc(n.slice(0, 1))}</span>`).join('')}</div></div>` : ''}
    <div class="grid2" style="margin-top:14px">${groups.map(list).join('') || `<p class="muted">${esc(T().nothingYet)}</p>`}</div>
    ${form}</section>`;
}

async function saveBudget() {
  const v = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLSelectElement).value;
  const amount = parseNum(v('bf-amount'));
  const name = v('bf-name').trim();
  if (!name || !isNum(amount)) return toast(L() === 'it' ? 'Nome e importo sono obbligatori' : 'Name and amount are required');
  const owner = v('bf-owner');
  const args = { name, amount, frequency: v('bf-freq'), dueMonth: v('bf-due') ? Number(v('bf-due')) : undefined, owner: owner === SHARED ? null : owner, kind: v('bf-kind') };
  try {
    if (S.demo) S.state!.budget.push({ id: 'b' + Date.now(), ...args, ownerId: args.owner, frequency: args.frequency as 'monthly', kind: args.kind as 'expense' });
    else {
      await callTool('conti_upsert_budget_item', args);
      await refresh();
    }
    S.budgetForm = false;
    toast(T().saved);
    render();
  } catch (e) {
    toast(String((e as Error).message));
  }
}

// ------------------------------------------------------------------ home

function newScenario(): HomeScenario {
  return { id: '', name: L() === 'it' ? 'Casa' : 'Home', price: 250000, familyHelp: 0, rate: 0.032, agencyFee: 0.03, agencyFeeVat: 0.22, closingCosts: 8000, capitalUse: {}, sharedCapitalUse: 1, durations: [20, 25, 30] };
}

function homeTab() {
  const st = S.state!;
  const H = T().home;
  if (!S.homeDraft) {
    const sc = st.scenarios.find((s) => s.id === S.homeId) ?? st.scenarios[0];
    if (sc) {
      S.homeDraft = structuredClone(sc);
      S.homeId = sc.id;
    }
  }
  if (!S.homeDraft)
    return `<section><h2>${esc(H.title)}</h2><p>${esc(H.empty)}</p><button class="btn primary" data-act="home-new">+ ${L() === 'it' ? 'Nuovo scenario' : 'New scenario'}</button></section>`;
  const d = S.homeDraft;
  const r: HomeResult = simulateHome(st, C, d);
  const f = (k: keyof HomeScenario, label: string, kind: 'eur' | 'pct') => {
    const v = d[k] as number;
    return `<div class="field"><label>${esc(label)}</label><input data-home="${k}" data-kind="${kind}" inputmode="decimal" value="${esc(kind === 'pct' ? num(v * 100, L(), 2) : num(v, L(), 0).replace(/\D/g, ''))}">${kind === 'pct' ? '<div class="hint">%</div>' : ''}</div>`;
  };
  const uses = st.members.map((m) => `<div class="field"><label>${esc(H.capitalUse)} · ${esc(m.name)}</label><input data-use="${m.id}" inputmode="decimal" value="${esc(num((d.capitalUse[m.id] ?? 1) * 100, L(), 0))}"><div class="hint">% · ${M(r.perOwner.find((o) => o.id === m.id)?.liquid)} ${esc(T().liquid.toLowerCase())}</div></div>`).join('');
  const sel = st.scenarios.length > 1 ? `<select class="month" data-act="home-pick">${st.scenarios.map((s) => `<option value="${esc(s.id)}" ${s.id === S.homeId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>` : '';
  return `<section><div class="row"><h2 style="margin:0">${esc(H.title)}</h2>${sel}<span class="spacer"></span>
    <button class="btn small" data-ask="${esc(homePrompt(r))}">${ICON_CHAT}${esc(T().askClaudeExplain)}</button></div>
    <div class="card" style="margin-top:12px"><div class="fields">
      <div class="field"><label>${esc(T().name)}</label><input data-home="name" data-kind="text" value="${esc(d.name)}"></div>
      ${f('price', H.price, 'eur')}${f('familyHelp', H.familyHelp, 'eur')}${f('rate', H.rate, 'pct')}${f('agencyFee', H.agencyFee, 'pct')}${f('agencyFeeVat', H.agencyFeeVat, 'pct')}${f('closingCosts', H.closingCosts, 'eur')}${uses}
    </div></div>
    <div class="grid2" style="margin-top:14px">
      <div class="card"><dl class="kv">
        <dt>${esc(H.price)}</dt><dd>${M(d.price)}</dd>
        <dt>${esc(H.agencyFee)}</dt><dd>${M(r.agencyFee)}</dd>
        <dt>${esc(H.closingCosts)}</dt><dd>${M(r.closingCosts)}</dd>
        <dt class="total">${esc(H.totalCost)}</dt><dd class="total">${M(r.totalCost)}</dd>
        <dt>${esc(H.ownFunds)}</dt><dd>− ${M(r.ownFunds)}</dd>
        <dt>${esc(H.familyHelp)}</dt><dd>− ${M(r.familyHelp)}</dd>
        <dt class="total">${esc(H.mortgage)} <small>LTV ${P(r.ltv)}</small></dt><dd class="total">${M(r.mortgage)}</dd>
      </dl></div>
      <div class="card"><dl class="kv">
        <dt>${L() === 'it' ? 'Entrate nette' : 'Net income'} <small>${esc(T().avgPerMonth)}</small></dt><dd>${M(r.householdNetIncome)}</dd>
        <dt>${esc(H.maxPayment)} <small>${P(st.settings.maxPaymentRatio)}</small></dt><dd>${M(r.maxPayment)}</dd>
        <dt>${esc(H.reserve)} <small>${num(r.reserveMonths, L(), 1)} ${esc(T().months)} · ${L() === 'it' ? 'obiettivo' : 'target'} ${r.reserveTarget}</small></dt><dd>${M(r.reserve)}</dd>
      </dl></div>
    </div>
    <div class="durs">${r.durations
      .map(
        (x) => `<div class="dur"><div class="y">${x.years} ${esc(H.years)}</div><div class="p">${M(x.payment)}</div>
        <span class="chip ${x.affordable === null ? 'na' : x.affordable ? 'good' : 'warn'}">${esc(x.affordable === null ? T().hs.na : x.affordable ? H.affordable : H.notAffordable)}</span>
        <dl class="kv" style="margin-top:6px;font-size:13px"><dt>${esc(H.interest)}</dt><dd>${M(x.totalInterest)}</dd><dt>${esc(H.maxPrice)}</dt><dd>${M(x.maxPriceWithSavings)}</dd></dl></div>`,
      )
      .join('')}</div>
    ${r.flags.length ? `<div class="flags">${r.flags.map((fl) => `<div>${esc(H.flags[fl])}</div>`).join('')}</div>` : ''}
    <div class="row" style="margin-top:14px"><button class="btn primary" data-act="home-save">${esc(T().save)}</button><button class="btn" data-act="home-new">+ ${L() === 'it' ? 'Nuovo scenario' : 'New scenario'}</button>
    ${S.homeId ? `<button class="btn ghost" data-act="home-delete">${esc(T().delete)}</button>` : ''}</div>
  </section>`;
}

function homePrompt(r: HomeResult) {
  const d = r.scenario;
  return L() === 'it'
    ? `Ho simulato in Conti l’acquisto di "${d.name}" a ${M(d.price)} con mutuo al ${P(d.rate, 2)}: mutuo di ${M(r.mortgage)}, rata a 30 anni ${M(r.durations.at(-1)?.payment)}. Spiegami se è sostenibile per noi, quali rischi vedi e quali leve (prezzo, durata, anticipo, tasso) contano di più.`
    : `I simulated buying "${d.name}" for ${M(d.price)} in Conti with a ${P(d.rate, 2)} mortgage: loan ${M(r.mortgage)}, 30-year payment ${M(r.durations.at(-1)?.payment)}. Explain whether it is sustainable for us, the risks you see and which levers (price, duration, down payment, rate) matter most.`;
}

async function saveHome() {
  const d = S.homeDraft!;
  try {
    if (S.demo) {
      if (!d.id) d.id = 'h' + Date.now();
      S.state!.scenarios = [...S.state!.scenarios.filter((s) => s.id !== d.id), structuredClone(d)];
    } else {
      const r = await callTool('conti_save_home_scenario', {
        id: d.id || undefined,
        name: d.name,
        price: d.price,
        familyHelp: d.familyHelp,
        rate: d.rate,
        agencyFee: d.agencyFee,
        agencyFeeVat: d.agencyFeeVat,
        closingCosts: d.closingCosts,
        capitalUse: Object.entries(d.capitalUse).map(([member, share]) => ({ member, share })),
        sharedCapitalUse: d.sharedCapitalUse,
        durations: d.durations,
      });
      const id = (r.structuredContent as { scenarioId?: string } | undefined)?.scenarioId;
      if (id) d.id = id;
      await refresh();
      tellModel(`The user saved the home scenario "${d.name}" (${M(d.price)}) in the Conti dashboard.`);
    }
    S.homeId = d.id;
    S.homeDraft = null;
    toast(T().saved);
    render();
  } catch (e) {
    toast(String((e as Error).message));
  }
}

// ------------------------------------------------------------------ purchase

function purchaseTab() {
  const p = S.purchase;
  const r = simulatePurchase(S.state!, C, p);
  const Tp = T().purchase;
  const f = (k: keyof PurchaseInput, label: string, kind: 'eur' | 'pct' | 'num' | 'text', hint?: string) => {
    const v = p[k];
    const s = v === undefined || v === null ? '' : kind === 'pct' ? num((v as number) * 100, L(), 2) : kind === 'text' ? String(v) : String(v);
    return `<div class="field"><label>${esc(label)}</label><input data-buy="${k}" data-kind="${kind}" ${kind === 'text' ? '' : 'inputmode="decimal"'} value="${esc(s)}">${hint ? `<div class="hint">${esc(hint)}</div>` : ''}</div>`;
  };
  const it = L() === 'it';
  return `<section><h2>${esc(Tp.title)}</h2>
    <p class="sub">${it ? 'Un acquisto confrontato con i vostri numeri reali: liquidità, fondo emergenze, entrate e risparmio.' : 'A purchase checked against your real numbers: cash, emergency fund, income and savings.'}</p>
    <div class="card"><div class="fields">
      ${f('name', T().name, 'text')}${f('price', T().home.price, 'eur')}${f('downPayment', it ? 'Anticipo in contanti' : 'Cash upfront', 'eur', it ? 'vuoto = tutto in contanti' : 'empty = all cash')}
      ${f('rate', it ? 'Tasso finanziamento' : 'Loan rate', 'pct', it ? '% · solo se finanzi' : '% · only if financed')}${f('years', it ? 'Durata (anni)' : 'Loan years', 'num')}${f('monthlyRunningCost', it ? 'Costi mensili extra' : 'Extra monthly costs', 'eur', it ? 'assicurazione, carburante, manutenzione…' : 'insurance, fuel, upkeep…')}
      ${f('expectedReturn', it ? 'Rendimento alternativo' : 'Alternative return', 'pct', '%')}
    </div></div>
    <div class="verdict ${r.verdict}" style="margin-top:14px"><span class="v">${esc(Tp.verdict[r.verdict])}</span><span class="spacer"></span>
      <button class="btn small accent" data-ask="${esc(purchasePrompt(r))}">${ICON_CHAT}${esc(T().askClaudeExplain)}</button></div>
    ${r.reasons.length ? `<ul class="reasons">${r.reasons.map((x) => `<li>${esc(Tp.reasons[x])}</li>`).join('')}</ul>` : ''}
    <div class="grid2" style="margin-top:14px">
      <div class="card"><dl class="kv">
        ${r.loan > 0 ? `<dt>${it ? 'Finanziamento' : 'Loan'}</dt><dd>${M(r.loan)}</dd><dt>${it ? 'Rata' : 'Payment'}</dt><dd>${M(r.payment)}</dd><dt>${esc(T().home.interest)}</dt><dd>${M(r.totalInterest)}</dd>` : ''}
        <dt>${it ? 'Nuovo impegno mensile' : 'New monthly commitment'}<small>${P(r.incomeShare)} ${it ? 'delle entrate' : 'of income'}</small></dt><dd>${M(r.newMonthlyCommitment)}</dd>
        <dt>${esc(Tp.opportunity)}<small>${P(r.input.expectedReturn, 1)} × ${r.input.horizonYears} ${it ? 'anni' : 'years'}</small></dt><dd>${M(r.opportunityCost)}</dd>
      </dl></div>
      <div class="card"><dl class="kv">
        <dt>${it ? 'Liquidità dopo' : 'Cash after'}</dt><dd class="${r.cashAfter < 0 ? 'neg' : ''}">${M(r.cashAfter)}</dd>
        <dt>${esc(T().health.emergencyFund.name)}<small>${it ? 'obiettivo' : 'target'} ${r.emergencyTarget} ${esc(T().months)}</small></dt><dd>${num(r.emergencyMonthsBefore, L(), 1)} → ${num(r.emergencyMonthsAfter, L(), 1)}</dd>
        <dt>${it ? 'Mesi di risparmio' : 'Months of savings'}</dt><dd>${num(r.monthsOfSavings, L(), 1)}</dd>
        <dt>${it ? 'Risparmio mensile dopo' : 'Monthly savings after'}</dt><dd class="${(r.savingsAfter ?? 0) < 0 ? 'neg' : ''}">${M(r.savingsAfter)}</dd>
      </dl></div>
    </div></section>`;
}

function purchasePrompt(r: ReturnType<typeof simulatePurchase>) {
  const it = L() === 'it';
  const what = r.input.name || (it ? 'un acquisto' : 'a purchase');
  return it
    ? `Sto valutando ${what} da ${M(r.input.price)}${r.loan > 0 ? `, con anticipo di ${M(r.input.downPayment)} e finanziamento a ${r.input.years} anni al ${P(r.input.rate, 1)}` : ' in contanti'}. Conti dice: "${T().purchase.verdict[r.verdict]}". Aiutami a ragionarci: cosa comporta per il nostro fondo emergenze e il risparmio, e quali alternative avrei?`
    : `I'm considering ${what} for ${M(r.input.price)}${r.loan > 0 ? `, ${M(r.input.downPayment)} upfront and a ${r.input.years}-year loan at ${P(r.input.rate, 1)}` : ' paid in cash'}. Conti says: "${T().purchase.verdict[r.verdict]}". Help me think it through: what it means for our emergency fund and savings, and what alternatives I have.`;
}

// ------------------------------------------------------------------ settings

function settingsTab() {
  const st = S.state!;
  const s = st.settings;
  const Ts = T().settings;
  const f = (k: string, label: string, v: number | null, kind: 'pct' | 'num') =>
    `<div class="field"><label>${esc(label)}</label><input data-set="${k}" data-kind="${kind}" inputmode="decimal" value="${v === null ? '' : esc(kind === 'pct' ? num(v * 100, L(), 1) : String(v))}">${kind === 'pct' ? '<div class="hint">%</div>' : ''}</div>`;
  const accs = st.accounts
    .map((a) => `<div class="bitem"><span><span class="sw" style="background:${accountColor(a)}"></span>${esc(a.name)}<small>${esc([a.institution, T().kinds[a.kind], a.liquid ? T().liquid : '', a.archived ? (L() === 'it' ? 'archiviato' : 'archived') : ''].filter(Boolean).join(' · '))}</small></span><span></span>
      <button class="btn small ghost" data-archive="${esc(a.id)}">${a.archived ? (L() === 'it' ? 'Ripristina' : 'Restore') : L() === 'it' ? 'Archivia' : 'Archive'}</button></div>`)
    .join('');
  return `<section><h2>${esc(T().tabs.settings)}</h2>
    <div class="card"><div class="fields">
      ${f('capitalGainsTax', Ts.capitalGainsTax, s.capitalGainsTax, 'pct')}
      ${f('emergencyMonths', Ts.emergencyMonths, s.emergencyMonths, 'num')}
      ${f('maxPaymentRatio', Ts.maxPaymentRatio, s.maxPaymentRatio, 'pct')}
      ${f('targetSavingsRate', Ts.targetSavingsRate, s.targetSavingsRate, 'pct')}
      ${f('referenceYear', Ts.referenceYear, s.referenceYear, 'num')}
      <div class="field"><label>${esc(Ts.language)}</label><select data-set="locale"><option value="en" ${L() === 'en' ? 'selected' : ''}>English</option><option value="it" ${L() === 'it' ? 'selected' : ''}>Italiano</option></select></div>
      <div class="field"><label>${esc(Ts.currency)}</label><input data-set="currency" data-kind="text" maxlength="3" value="${esc(cur())}"></div>
    </div><div class="row" style="margin-top:12px"><button class="btn primary" data-act="settings-save">${esc(T().save)}</button>
    <button class="btn" data-act="export">${esc(Ts.export)}</button></div></div>
    <h3 style="margin-top:22px">${esc(T().members)}</h3><p>${st.members.map((m) => `<span class="sw" style="background:${ownerColor(m.id)}"></span>${esc(m.name)}`).join(' &nbsp; ')}</p>
    <h3 style="margin-top:18px">${esc(T().accounts)}</h3><div class="blist">${accs}</div>
    <p class="sub" style="margin-top:12px">${L() === 'it' ? 'Per aggiungere persone o conti, o cambiare le quote di proprietà, chiedi a Claude.' : 'To add people or accounts, or change ownership shares, ask Claude.'}</p>
  </section>`;
}

async function saveSettings() {
  const patch: Record<string, unknown> = {};
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-set]').forEach((el) => {
    const k = el.dataset.set!;
    const kind = el.dataset.kind;
    if (k === 'locale' || kind === 'text') {
      patch[k] = el.value.trim() || undefined;
      return;
    }
    const v = parseNum(el.value, kind === 'pct');
    if (k === 'referenceYear') patch[k] = v === null ? null : v;
    else if (isNum(v)) patch[k] = kind === 'pct' ? v / 100 : v;
  });
  try {
    if (S.demo) {
      const st = S.state!;
      const { locale, currency, ...rest } = patch as { locale?: Locale; currency?: string };
      st.household = { ...st.household!, locale: locale ?? L(), currency: currency?.toUpperCase() ?? cur() };
      st.settings = { ...st.settings, ...(rest as object) };
    } else {
      await callTool('conti_update_settings', patch);
      await refresh();
    }
    toast(T().saved);
    render();
  } catch (e) {
    toast(String((e as Error).message));
  }
}

async function exportJson() {
  const text = JSON.stringify({ format: 'conti-mcp', exportedAt: new Date().toISOString(), state: S.state }, null, 2);
  const name = `conti-backup-${S.today}.json`;
  if (S.app && S.canDownload) {
    try {
      await S.app.downloadFile({ contents: [{ type: 'resource', resource: { uri: `file:///${name}`, mimeType: 'application/json', text } }] });
      return;
    } catch (e) {
      console.error(e);
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  a.click();
}

// ------------------------------------------------------------------ events

function afterRender() {
  drawChart();
}

root.addEventListener('click', async (ev) => {
  const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-tab],[data-act],[data-ask],[data-metric],[data-hist],[data-del-budget],[data-archive]');
  if (!el) return;
  if (el.dataset.tab) {
    S.tab = el.dataset.tab as Tab;
    if (el.dataset.month) S.month = el.dataset.month;
    render();
    document.getElementById('main')?.scrollIntoView({ block: 'start' });
    return;
  }
  if (el.dataset.ask) return void askClaude(el.dataset.ask);
  if (el.dataset.metric) {
    const id = el.dataset.metric;
    S.openMetrics.has(id) ? S.openMetrics.delete(id) : S.openMetrics.add(id);
    el.setAttribute('aria-expanded', String(S.openMetrics.has(id)));
    return;
  }
  if (el.dataset.hist) {
    S.histOwner = el.dataset.hist;
    return render();
  }
  if (el.dataset.delBudget) {
    const id = el.dataset.delBudget;
    if (S.demo) S.state!.budget = S.state!.budget.filter((b) => b.id !== id);
    else {
      await callTool('conti_delete_budget_item', { item: id }).catch((e) => toast(e.message));
      await refresh();
    }
    return render();
  }
  if (el.dataset.archive) {
    const a = S.state!.accounts.find((x) => x.id === el.dataset.archive)!;
    if (S.demo) a.archived = !a.archived;
    else {
      await callTool('conti_upsert_account', { id: a.id, name: a.name, institution: a.institution, kind: a.kind, owners: a.owners.map((o) => ({ member: o.memberId, share: o.share })), liquid: a.liquid, archived: !a.archived }).catch((e) => toast(e.message));
      await refresh();
    }
    return render();
  }
  switch (el.dataset.act) {
    case 'save-month': return saveMonth();
    case 'discard': S.monthDraft = {}; return render();
    case 'budget-add': S.budgetForm = true; return render();
    case 'budget-cancel': S.budgetForm = false; return render();
    case 'budget-save': return saveBudget();
    case 'home-new': S.homeDraft = newScenario(); S.homeId = null; return render();
    case 'home-save': return saveHome();
    case 'home-delete':
      if (S.homeId) {
        if (S.demo) S.state!.scenarios = S.state!.scenarios.filter((s) => s.id !== S.homeId);
        else {
          await callTool('conti_delete_home_scenario', { id: S.homeId }).catch((e) => toast(e.message));
          await refresh();
        }
        S.homeId = null;
        S.homeDraft = null;
        render();
      }
      return;
    case 'settings-save': return saveSettings();
    case 'export': return exportJson();
    case 'fullscreen':
      if (S.app) {
        try {
          const r = await S.app.requestDisplayMode({ mode: S.fullscreen ? 'inline' : 'fullscreen' });
          S.fullscreen = r.mode === 'fullscreen';
          render();
        } catch (e) {
          console.error(e);
        }
      }
      return;
  }
});

root.addEventListener('change', (ev) => {
  const el = ev.target as HTMLSelectElement;
  if (el.id === 'month-sel') {
    if (Object.keys(S.monthDraft).length && !confirm(L() === 'it' ? 'Scartare le modifiche non salvate?' : 'Discard unsaved changes?')) {
      el.value = S.month;
      return;
    }
    S.monthDraft = {};
    S.month = el.value;
    render();
  }
  if (el.dataset.act === 'home-pick') {
    S.homeId = el.value;
    S.homeDraft = null;
    render();
  }
});

let inputTimer = 0;
root.addEventListener('input', (ev) => {
  const el = ev.target as HTMLInputElement;
  if (el.dataset.draft) {
    const key = el.dataset.draft;
    const [kind, id] = key.split('|') as [string, string];
    const stored = kind === 'b' ? snapOf(id, S.month)?.balance : kind === 'g' ? snapOf(id, S.month)?.unrealizedGain : kind === 'n' ? incOf(id, S.month)?.net : incOf(id, S.month)?.extra;
    const was = isNum(stored) ? stored : null;
    const now = parseNum(el.value);
    if (now === was) delete S.monthDraft[key];
    else S.monthDraft[key] = el.value;
    el.setAttribute('aria-invalid', String(Number.isNaN(now)));
    // re-render only the save bar to keep focus
    const hasBar = !!document.querySelector('.savebar');
    if (hasBar !== Object.keys(S.monthDraft).length > 0) rerenderKeepingFocus();
    return;
  }
  const live = el.dataset.home ?? el.dataset.buy ?? el.dataset.use;
  if (!live) return;
  if (el.dataset.use && S.homeDraft) {
    const v = parseNum(el.value, true);
    if (isNum(v)) S.homeDraft.capitalUse[el.dataset.use] = Math.max(0, Math.min(1, v / 100));
  } else if (el.dataset.home && S.homeDraft) {
    const k = el.dataset.home as keyof HomeScenario;
    if (el.dataset.kind === 'text') (S.homeDraft as unknown as Record<string, unknown>)[k] = el.value;
    else {
      const v = parseNum(el.value, el.dataset.kind === 'pct');
      if (isNum(v)) (S.homeDraft as unknown as Record<string, number>)[k] = el.dataset.kind === 'pct' ? v / 100 : v;
    }
  } else if (el.dataset.buy) {
    const k = el.dataset.buy as keyof PurchaseInput;
    if (el.dataset.kind === 'text') (S.purchase as unknown as Record<string, unknown>)[k] = el.value;
    else {
      const v = parseNum(el.value, el.dataset.kind === 'pct');
      (S.purchase as unknown as Record<string, unknown>)[k] = v === null ? undefined : isNum(v) ? (el.dataset.kind === 'pct' ? v / 100 : v) : (S.purchase as unknown as Record<string, unknown>)[k];
    }
  }
  clearTimeout(inputTimer);
  inputTimer = window.setTimeout(rerenderKeepingFocus, 250);
});

function rerenderKeepingFocus() {
  const a = document.activeElement as HTMLInputElement | null;
  const sel = a?.dataset ? Object.entries(a.dataset).map(([k, v]) => `[data-${k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}="${CSS.escape(v ?? '')}"]`).join('') : '';
  const pos = a && 'selectionStart' in a ? [a.selectionStart, a.selectionEnd] : null;
  render();
  if (sel) {
    const b = document.querySelector<HTMLInputElement>(sel);
    if (b) {
      b.focus();
      if (pos && pos[0] !== null) {
        try {
          b.setSelectionRange(pos[0], pos[1]);
        } catch {
          /* not a text input */
        }
      }
    }
  }
}

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(drawChart, 120);
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !S.demo && !S.busy && !Object.keys(S.monthDraft).length) refresh();
});

// ------------------------------------------------------------------ boot

function applyHostContext(ctx: Record<string, unknown> | undefined) {
  if (!ctx) return;
  if (ctx.theme === 'dark' || ctx.theme === 'light') document.documentElement.dataset.theme = ctx.theme as string;
  if (typeof ctx.locale === 'string') S.hostLocale = ctx.locale.toLowerCase().startsWith('it') ? 'it' : 'en';
  if (Array.isArray(ctx.availableDisplayModes)) S.canFullscreen = ctx.availableDisplayModes.includes('fullscreen');
  if (ctx.displayMode) S.fullscreen = ctx.displayMode === 'fullscreen';
}

function startDemo() {
  S.demo = true;
  const d = new Date();
  S.today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const q = new URLSearchParams(location.search);
  S.state = q.has('empty') ? emptyState() : demoState(S.today);
  if (q.get('lang') === 'it') {
    S.hostLocale = 'it';
    if (S.state.household) S.state.household.locale = 'it';
  }
  if (q.get('tab')) S.tab = q.get('tab') as Tab;
  if (q.get('theme') === 'dark' || q.get('theme') === 'light') document.documentElement.dataset.theme = q.get('theme')!;
  render();
}

async function boot() {
  render();
  if (window.parent === window) return startDemo();
  const app = new App({ name: 'Conti', version: '0.1.0' }, {}, { autoResize: true });
  app.ontoolresult = (p) => {
    const sc = (p as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
    if (typeof sc.tab === 'string' && (TABS as string[]).concat('settings').includes(sc.tab)) S.tab = sc.tab as Tab;
    if (typeof sc.month === 'string') S.month = sc.month;
    const res = sc.result as Record<string, unknown> | undefined;
    if (sc.tab === 'purchase' && res?.input) S.purchase = { ...(res.input as PurchaseInput) };
    if (sc.tab === 'home' && res?.scenario) {
      S.homeDraft = structuredClone(res.scenario as HomeScenario);
      S.homeId = (sc.scenarioId as string | null) ?? null;
      if (!S.homeId) S.homeDraft.id = '';
    }
    refresh();
  };
  app.onhostcontextchanged = (ctx) => {
    applyHostContext(ctx as Record<string, unknown>);
    render();
  };
  try {
    await Promise.race([app.connect(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))]);
  } catch (e) {
    console.warn('No MCP host, running demo', e);
    return startDemo();
  }
  S.app = app;
  const caps = app.getHostCapabilities() ?? {};
  S.canMessage = !!caps.message;
  S.canDownload = !!caps.downloadFile;
  applyHostContext(app.getHostContext() as Record<string, unknown> | undefined);
  await refresh();
}

boot();
