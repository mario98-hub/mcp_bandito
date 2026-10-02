/** Serializable view model sent to the dashboard UI. */
import {
  compute,
  goalProgress,
  monthRange,
  nextKey,
  onboardingNext,
  purchaseBudget,
  resolveModules,
  simulateHome,
  type Computed,
  type GoalProgress,
  type HomeResult,
  type MonthStatus,
  type OnboardingNext,
  type PurchaseBudget,
} from '../core/engine.js';
import type { Goal, ModuleKey, MonthKey, State } from '../core/types.js';

export interface View {
  today: MonthKey;
  state: State;
  computed: Omit<Computed, 'statusOf'>;
  statuses: Record<MonthKey, MonthStatus>;
  home: HomeResult[];
  onboarding: OnboardingNext;
  modules: Record<ModuleKey, boolean>;
  goals: { goal: Goal; progress: GoalProgress }[];
  purchaseBudget: PurchaseBudget;
}

export function buildView(state: State, today: MonthKey): View {
  const c = compute(state, { today });
  const { statusOf, ...rest } = c;
  const statuses: Record<MonthKey, MonthStatus> = {};
  const first = c.months[0] ?? today;
  const last = c.latestMonth && c.latestMonth > today ? c.latestMonth : today;
  for (const m of monthRange(first, last)) statuses[m] = statusOf(m);
  if (!statuses[nextKey(last)]) statuses[nextKey(last)] = statusOf(nextKey(last));
  return {
    today,
    state,
    computed: rest,
    statuses,
    home: state.scenarios.map((s) => simulateHome(state, c, s)),
    onboarding: onboardingNext(state),
    modules: resolveModules(state),
    goals: state.goals.filter((g) => g.status !== 'archived').map((goal) => ({ goal, progress: goalProgress(state, c, goal) })),
    purchaseBudget: purchaseBudget(state, c, {}),
  };
}
