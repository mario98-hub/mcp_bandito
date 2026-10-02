/**
 * Conti data model.
 *
 * A household has 1..N members. Money lives in accounts; each account is owned
 * by one or more members (with shares) or is shared by the whole household.
 * Once a month the user records a snapshot of every account balance and the
 * net income of every member. Everything else (savings, spending, savings
 * rate, emergency fund, home affordability) is derived by the engine.
 */

/** Month key, `YYYY-MM`. */
export type MonthKey = string;

export type Locale = 'en' | 'it';

export interface Household {
  name: string;
  currency: string; // ISO 4217, e.g. EUR
  locale: Locale;
  createdAt: string;
}

export interface Member {
  id: string;
  name: string;
  color?: string;
  /** Day of the month the salary usually lands (1-31); drives the reminder-day rule. */
  payday?: number;
}

export type AccountKind =
  | 'cash' // current/checking/savings accounts
  | 'investment' // brokerage, funds, ETFs, crypto
  | 'pension' // pension funds, TFR: not liquid by default
  | 'property' // real estate, car… (not liquid)
  | 'debt' // loans, mortgages, credit cards: stored as negative balances
  | 'other';

export interface Owner {
  memberId: string;
  /** Fraction of the account that belongs to this member, 0..1. */
  share: number;
}

export interface Account {
  id: string;
  name: string;
  institution?: string;
  kind: AccountKind;
  /**
   * Owners and their shares. Empty = fully shared by the household.
   * If shares sum to less than 1, the remainder is household-shared.
   */
  owners: Owner[];
  /** Counts towards the emergency fund and the cash available for a purchase. */
  liquid: boolean;
  archived?: boolean;
  note?: string;
}

export interface Snapshot {
  accountId: string;
  month: MonthKey;
  /** Balance at month end. Negative for debts. */
  balance: number;
  /** Unrealized capital gain included in the balance (taxed if you sell). */
  unrealizedGain?: number;
  /**
   * Optional explicit amounts per member that override the account's shares
   * for this month (e.g. "€4,000 of the joint account are Mario's deposit").
   * Whatever is left is household-shared.
   */
  allocations?: Record<string, number>;
  note?: string;
  updatedAt?: string;
}

export interface Income {
  memberId: string;
  month: MonthKey;
  /** Net salary / regular net income for the month. */
  net: number;
  /** One-offs: bonus, 13th/14th salary, refunds, side gigs. */
  extra?: number;
  note?: string;
  updatedAt?: string;
}

export type BudgetFrequency = 'monthly' | 'annual';
export type BudgetKind = 'expense' | 'saving';

export interface BudgetItem {
  id: string;
  name: string;
  amount: number;
  frequency: BudgetFrequency;
  /** For annual items: month (1-12) when it is usually paid. */
  dueMonth?: number;
  /** Member who pays it; null/undefined = household-shared. */
  ownerId?: string | null;
  /** `saving` = planned investments (PAC/accumulation plans), `expense` otherwise. */
  kind: BudgetKind;
  category?: string;
  note?: string;
}

/** The six onboarding objectives. The primary one drives header, modules and tone. */
export type GoalKind =
  | 'spending' // understand where the money goes
  | 'emergency' // build an emergency fund
  | 'home' // buy a home
  | 'invest' // invest
  | 'debt' // pay off a debt
  | 'purchase'; // a significant purchase

export type GoalStatus = 'active' | 'reached' | 'archived';

export interface Goal {
  id: string;
  kind: GoalKind;
  /** Exactly one goal is primary; it decides the header figure and step-6 questions. */
  primary: boolean;
  name?: string;
  /** Target amount, if the user set one. */
  targetAmount?: number;
  /** Target date (`YYYY-MM-DD` or `YYYY-MM`); optional — without it the engine estimates at the current pace. */
  targetDate?: string;
  /** Accounts that count towards this goal; empty = liquidity beyond the emergency fund. */
  accountIds: string[];
  status: GoalStatus;
}

/** Optional modules that switch themselves on from the objective or the data. */
export type ModuleKey = 'invest' | 'home' | 'debt' | 'fixed';
/** `auto` = decided by goals + data; `on`/`off` = forced by the user. */
export type ModuleMode = 'auto' | 'on' | 'off';

export interface ReminderSettings {
  /** Day of the month for the monthly-update reminder (1-31). */
  day?: number;
  /** Delivery channel: 'calendar', 'task' (Claude scheduled task) or 'passive'. */
  channel?: string;
  /** Extra, individually disable-able reminders. */
  extras?: {
    yearReview?: boolean;
    annualExpense?: boolean;
    goalMilestones?: boolean;
  };
}

export interface Settings {
  /** Tax rate on capital gains (Italy: 26%). */
  capitalGainsTax: number;
  /** Months of household spending the emergency fund should cover. */
  emergencyMonths: number;
  /** Max mortgage payment as share of net household income (banks: ~30-35%). */
  maxPaymentRatio: number;
  /** Target savings rate used by the health check. */
  targetSavingsRate: number;
  /** Year used for averages; null = latest year with income data. */
  referenceYear: number | null;
  /** Per-module activation (auto from goals+data, or forced on/off). */
  modules: Record<ModuleKey, ModuleMode>;
  /**
   * A purchase is "relevant" (Conti should weigh in from a free chat) above this
   * share of monthly net income — or whenever it is on instalments. Default 0.20.
   */
  relevanceThreshold: number;
  /** Monthly-update reminder preferences (filled at onboarding step 7). */
  reminder?: ReminderSettings;
}

export interface HomeScenario {
  id: string;
  name: string;
  price: number;
  /** Gifts/help from family towards the purchase. */
  familyHelp: number;
  /** Annual nominal mortgage rate (TAN), e.g. 0.035. */
  rate: number;
  /** Agency fee as fraction of price, e.g. 0.03. */
  agencyFee: number;
  /** VAT on the agency fee, e.g. 0.22. */
  agencyFeeVat: number;
  /** Notary, taxes, appraisal, other closing costs. */
  closingCosts: number;
  /** Fraction of each member's liquid wealth they put into the house (0..1). */
  capitalUse: Record<string, number>;
  /** Fraction of the household-shared liquid wealth put into the house. */
  sharedCapitalUse: number;
  /** Mortgage durations to compare, in years. */
  durations: number[];
  note?: string;
}

export interface State {
  version: 1;
  revision: number;
  household: Household | null;
  members: Member[];
  accounts: Account[];
  snapshots: Snapshot[];
  incomes: Income[];
  budget: BudgetItem[];
  settings: Settings;
  scenarios: HomeScenario[];
  goals: Goal[];
}

export const DEFAULT_SETTINGS: Settings = {
  capitalGainsTax: 0.26,
  emergencyMonths: 6,
  maxPaymentRatio: 0.33,
  targetSavingsRate: 0.2,
  referenceYear: null,
  modules: { invest: 'auto', home: 'auto', debt: 'auto', fixed: 'auto' },
  relevanceThreshold: 0.2,
};

export function emptyState(): State {
  return {
    version: 1,
    revision: 0,
    household: null,
    members: [],
    accounts: [],
    snapshots: [],
    incomes: [],
    budget: [],
    settings: { ...DEFAULT_SETTINGS },
    scenarios: [],
    goals: [],
  };
}

/** Pseudo-owner id for the household-shared part of the wealth. */
export const SHARED = '_shared';
