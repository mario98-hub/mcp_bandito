/** Serializable view model sent to the dashboard UI. */
import { compute, monthRange, nextKey, simulateHome, type Computed, type HomeResult, type MonthStatus } from '../core/engine.js';
import type { MonthKey, State } from '../core/types.js';

export interface View {
  today: MonthKey;
  state: State;
  computed: Omit<Computed, 'statusOf'>;
  statuses: Record<MonthKey, MonthStatus>;
  home: HomeResult[];
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
  };
}
