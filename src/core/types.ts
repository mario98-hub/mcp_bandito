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
}

export const DEFAULT_SETTINGS: Settings = {
  capitalGainsTax: 0.26,
  emergencyMonths: 6,
  maxPaymentRatio: 0.33,
  targetSavingsRate: 0.2,
  referenceYear: null,
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
  };
}

/** Pseudo-owner id for the household-shared part of the wealth. */
export const SHARED = '_shared';
