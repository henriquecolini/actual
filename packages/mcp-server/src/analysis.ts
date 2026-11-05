import type { TxRow } from './data';
import { addDays, addMonths, daysBetween, round, toMoney } from './format';

// All functions here are pure: rows in, plain numbers out. Amounts in rows are
// cents; results are decimal money.

export const STARTING_BALANCE_CATEGORY = 'Starting Balances';

export type Kind = 'income' | 'expense' | 'transfer' | 'starting';

export function kindOf(row: TxRow): Kind {
  if (row.isTransfer) return 'transfer';
  if (row.categoryName === STARTING_BALANCE_CATEGORY) return 'starting';
  if (row.isIncomeCategory || (row.category === null && row.amount > 0)) {
    return 'income';
  }
  return 'expense';
}

type ScopeOptions = { includeOffBudget?: boolean };

function inScope(row: TxRow, options: ScopeOptions): boolean {
  return options.includeOffBudget ? true : !row.offBudget;
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(mean(values.map(v => (v - avg) ** 2)));
}

/** Lower-cases and strips reference numbers so "NETFLIX 4821" matches "Netflix". */
export function normalizePayee(payee: string | null): string {
  if (!payee) return '';
  return payee
    .toLowerCase()
    .replace(/\d{3,}/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------- spending

export type SpendingDimension = 'category' | 'group' | 'payee' | 'month';

export type SpendingRow = {
  name: string;
  total: number;
  transactions: number;
  share_percent: number;
};

/** Net spending (refunds reduce it), largest first. */
export function spendingBy(
  rows: TxRow[],
  dimension: SpendingDimension,
  options: ScopeOptions & { topN?: number } = {},
): { total: number; rows: SpendingRow[] } {
  const buckets = new Map<string, { cents: number; count: number }>();
  let totalCents = 0;

  for (const row of rows) {
    if (!inScope(row, options) || kindOf(row) !== 'expense') continue;
    const key =
      dimension === 'category'
        ? (row.categoryName ?? 'Uncategorized')
        : dimension === 'group'
          ? (row.categoryGroup ?? 'Uncategorized')
          : dimension === 'payee'
            ? (row.payee ?? '(no payee)')
            : monthOf(row.date);
    const bucket = buckets.get(key) ?? { cents: 0, count: 0 };
    bucket.cents += -row.amount;
    bucket.count += 1;
    buckets.set(key, bucket);
    totalCents += -row.amount;
  }

  let result = [...buckets.entries()].map(([name, b]) => ({
    name,
    total: toMoney(b.cents),
    transactions: b.count,
    share_percent: totalCents > 0 ? round((b.cents / totalCents) * 100, 1) : 0,
  }));
  result =
    dimension === 'month'
      ? result.sort((a, b) => a.name.localeCompare(b.name))
      : result.sort((a, b) => b.total - a.total);
  if (options.topN && dimension !== 'month') {
    result = result.slice(0, options.topN);
  }
  return { total: toMoney(totalCents), rows: result };
}

export type MonthSummary = {
  month: string;
  income: number;
  expenses: number;
  net: number;
  savings_rate_percent: number | null;
};

export function incomeVsExpense(
  rows: TxRow[],
  months: string[],
  options: ScopeOptions = {},
): MonthSummary[] {
  const byMonth = new Map<string, { income: number; expense: number }>();
  for (const month of months) byMonth.set(month, { income: 0, expense: 0 });

  for (const row of rows) {
    if (!inScope(row, options)) continue;
    const bucket = byMonth.get(monthOf(row.date));
    if (!bucket) continue;
    const kind = kindOf(row);
    if (kind === 'income') bucket.income += row.amount;
    else if (kind === 'expense') bucket.expense += -row.amount;
  }

  return months.map(month => {
    const { income, expense } = byMonth.get(month)!;
    return {
      month,
      income: toMoney(income),
      expenses: toMoney(expense),
      net: toMoney(income - expense),
      savings_rate_percent:
        income > 0 ? round(((income - expense) / income) * 100, 1) : null,
    };
  });
}

export function monthlySeries(
  rows: TxRow[],
  months: string[],
  match: (row: TxRow) => boolean,
  options: ScopeOptions = {},
): { month: string; total: number; transactions: number }[] {
  const byMonth = new Map<string, { cents: number; count: number }>();
  for (const month of months) byMonth.set(month, { cents: 0, count: 0 });
  for (const row of rows) {
    if (!inScope(row, options) || kindOf(row) !== 'expense' || !match(row)) {
      continue;
    }
    const bucket = byMonth.get(monthOf(row.date));
    if (!bucket) continue;
    bucket.cents += -row.amount;
    bucket.count += 1;
  }
  return months.map(month => ({
    month,
    total: toMoney(byMonth.get(month)!.cents),
    transactions: byMonth.get(month)!.count,
  }));
}

// -------------------------------------------------------------- net worth

export type NetWorthPoint = {
  month: string;
  net_worth: number;
  on_budget: number;
  off_budget: number;
};

/** Balance at the end of each month, summing every account's history. */
export function netWorthSeries(
  rows: TxRow[],
  months: string[],
): NetWorthPoint[] {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  let cursor = 0;
  let on = 0;
  let off = 0;
  return months.map(month => {
    const end = `${month}-31`; // string comparison is enough for ISO dates
    while (cursor < sorted.length && sorted[cursor].date <= end) {
      if (sorted[cursor].offBudget) off += sorted[cursor].amount;
      else on += sorted[cursor].amount;
      cursor++;
    }
    return {
      month,
      net_worth: toMoney(on + off),
      on_budget: toMoney(on),
      off_budget: toMoney(off),
    };
  });
}

// --------------------------------------------------------------- recurring

export type Cadence =
  | 'weekly'
  | 'biweekly'
  | 'monthly'
  | 'quarterly'
  | 'yearly';

const CADENCES: { name: Cadence; days: number; tolerance: number }[] = [
  { name: 'weekly', days: 7, tolerance: 2 },
  { name: 'biweekly', days: 14, tolerance: 3 },
  { name: 'monthly', days: 30.5, tolerance: 5 },
  { name: 'quarterly', days: 91, tolerance: 10 },
  { name: 'yearly', days: 365, tolerance: 15 },
];

const PER_YEAR: Record<Cadence, number> = {
  weekly: 52,
  biweekly: 26,
  monthly: 12,
  quarterly: 4,
  yearly: 1,
};

export type RecurringItem = {
  payee: string;
  direction: 'expense' | 'income';
  cadence: Cadence;
  typical_amount: number;
  amount_varies: boolean;
  occurrences: number;
  first_date: string;
  last_date: string;
  next_expected: string;
  annualized: number;
  category: string | null;
};

export function detectRecurring(
  rows: TxRow[],
  options: ScopeOptions & { minOccurrences?: number } = {},
): RecurringItem[] {
  const minOccurrences = options.minOccurrences ?? 3;
  const groups = new Map<string, TxRow[]>();

  for (const row of rows) {
    if (!inScope(row, options)) continue;
    const kind = kindOf(row);
    if (kind !== 'expense' && kind !== 'income') continue;
    const key = normalizePayee(row.payee);
    if (!key) continue;
    const list = groups.get(`${kind}:${key}`) ?? [];
    list.push(row);
    groups.set(`${kind}:${key}`, list);
  }

  const items: RecurringItem[] = [];
  for (const [key, group] of groups) {
    if (group.length < minOccurrences) continue;
    const sorted = [...group].sort((a, b) => a.date.localeCompare(b.date));
    const intervals: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const gap = daysBetween(sorted[i - 1].date, sorted[i].date);
      // Same-day repeats are separate purchases, not a schedule.
      if (gap > 0) intervals.push(gap);
    }
    if (intervals.length < minOccurrences - 1) continue;

    const typicalGap = median(intervals);
    const cadence = CADENCES.find(
      c => Math.abs(typicalGap - c.days) <= c.tolerance,
    );
    if (!cadence) continue;
    const regular = intervals.filter(
      gap => Math.abs(gap - cadence.days) <= cadence.tolerance * 1.5,
    );
    if (regular.length / intervals.length < 0.7) continue;

    const amounts = sorted.map(r => Math.abs(r.amount));
    const typical = median(amounts);
    const spread = typical > 0 ? stdDev(amounts) / typical : 0;
    const last = sorted[sorted.length - 1];

    items.push({
      payee: sorted[sorted.length - 1].payee ?? key,
      direction: key.startsWith('income:') ? 'income' : 'expense',
      cadence: cadence.name,
      typical_amount: toMoney(typical),
      amount_varies: spread > 0.25,
      occurrences: sorted.length,
      first_date: sorted[0].date,
      last_date: last.date,
      next_expected: addDays(last.date, Math.round(cadence.days)),
      annualized: toMoney(typical * PER_YEAR[cadence.name]),
      category: last.categoryName,
    });
  }
  return items.sort((a, b) => b.annualized - a.annualized);
}

// -------------------------------------------------------------- duplicates

export type DuplicatePair = {
  first: Pick<TxRow, 'id' | 'date' | 'accountName' | 'payee'> & {
    amount: number;
  };
  second: Pick<TxRow, 'id' | 'date' | 'accountName' | 'payee'> & {
    amount: number;
  };
  days_apart: number;
};

/** Same account, amount and payee within a couple of days. */
export function findDuplicates(
  rows: TxRow[],
  options: { maxDaysApart?: number } = {},
): DuplicatePair[] {
  const maxDays = options.maxDaysApart ?? 2;
  const groups = new Map<string, TxRow[]>();
  for (const row of rows) {
    if (row.isTransfer || row.amount === 0) continue;
    const key = `${row.account}|${row.amount}|${normalizePayee(row.payee)}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  const pairs: DuplicatePair[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 1; i < sorted.length; i++) {
      const gap = daysBetween(sorted[i - 1].date, sorted[i].date);
      if (gap <= maxDays) {
        const brief = (r: TxRow) => ({
          id: r.id,
          date: r.date,
          accountName: r.accountName,
          payee: r.payee,
          amount: toMoney(r.amount),
        });
        pairs.push({
          first: brief(sorted[i - 1]),
          second: brief(sorted[i]),
          days_apart: gap,
        });
      }
    }
  }
  return pairs.sort((a, b) => b.second.date.localeCompare(a.second.date));
}

// --------------------------------------------------------------- anomalies

export type SpikeFinding = {
  category: string;
  month: string;
  spent: number;
  typical: number;
  times_typical: number;
};

export type LargeTransactionFinding = {
  id: string;
  date: string;
  payee: string | null;
  category: string | null;
  amount: number;
  typical_for_payee: number;
};

/**
 * Category spend well above its own history, and single transactions far
 * larger than that payee's norm.
 */
export function findAnomalies(
  rows: TxRow[],
  lastMonths: string[],
  options: ScopeOptions & { minAmount?: number } = {},
): { spikes: SpikeFinding[]; large_transactions: LargeTransactionFinding[] } {
  const minCents = Math.round((options.minAmount ?? 50) * 100);
  const byCategory = new Map<string, Map<string, number>>();
  const byPayee = new Map<string, TxRow[]>();

  for (const row of rows) {
    if (!inScope(row, options) || kindOf(row) !== 'expense') continue;
    const category = row.categoryName ?? 'Uncategorized';
    const months = byCategory.get(category) ?? new Map<string, number>();
    months.set(
      monthOf(row.date),
      (months.get(monthOf(row.date)) ?? 0) - row.amount,
    );
    byCategory.set(category, months);

    const payeeKey = normalizePayee(row.payee);
    if (payeeKey) {
      const list = byPayee.get(payeeKey) ?? [];
      list.push(row);
      byPayee.set(payeeKey, list);
    }
  }

  const spikes: SpikeFinding[] = [];
  for (const [category, months] of byCategory) {
    for (const month of lastMonths) {
      const spent = months.get(month) ?? 0;
      const history: number[] = [];
      for (let i = 1; i <= 6; i++) {
        history.push(months.get(addMonths(month, -i)) ?? 0);
      }
      const active = history.filter(v => v > 0);
      if (active.length < 3) continue;
      const avg = mean(history);
      const limit = avg + 2 * stdDev(history);
      if (spent > limit && spent - avg > minCents) {
        spikes.push({
          category,
          month,
          spent: toMoney(spent),
          typical: toMoney(avg),
          times_typical: avg > 0 ? round(spent / avg, 1) : 0,
        });
      }
    }
  }

  const large: LargeTransactionFinding[] = [];
  for (const list of byPayee.values()) {
    if (list.length < 4) continue;
    const typical = median(list.map(r => -r.amount));
    for (const row of list) {
      if (!lastMonths.includes(monthOf(row.date))) continue;
      const cents = -row.amount;
      if (cents > typical * 3 && cents > minCents) {
        large.push({
          id: row.id,
          date: row.date,
          payee: row.payee,
          category: row.categoryName,
          amount: toMoney(cents),
          typical_for_payee: toMoney(typical),
        });
      }
    }
  }

  return {
    spikes: spikes.sort((a, b) => b.times_typical - a.times_typical),
    large_transactions: large.sort((a, b) => b.amount - a.amount),
  };
}

// ------------------------------------------------------------ uncategorized

export type UncategorizedSummary = {
  count: number;
  total_spent: number;
  oldest: string | null;
  top_payees: {
    payee: string;
    count: number;
    total: number;
    sample_ids: string[];
  }[];
};

export function summarizeUncategorized(
  rows: TxRow[],
  topN = 30,
): UncategorizedSummary {
  const pending = rows.filter(r => r.category === null && !r.isTransfer);
  const byPayee = new Map<
    string,
    { count: number; cents: number; ids: string[] }
  >();
  let totalCents = 0;
  let oldest: string | null = null;
  for (const row of pending) {
    totalCents += -row.amount;
    if (!oldest || row.date < oldest) oldest = row.date;
    const key = row.payee ?? '(no payee)';
    const bucket = byPayee.get(key) ?? { count: 0, cents: 0, ids: [] };
    bucket.count += 1;
    bucket.cents += -row.amount;
    if (bucket.ids.length < 5) bucket.ids.push(row.id);
    byPayee.set(key, bucket);
  }
  return {
    count: pending.length,
    total_spent: toMoney(totalCents),
    oldest,
    top_payees: [...byPayee.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, topN)
      .map(([payee, b]) => ({
        payee,
        count: b.count,
        total: toMoney(b.cents),
        sample_ids: b.ids,
      })),
  };
}

// -------------------------------------------------------- payee → category

export type PayeeCategoryHistory = {
  payee: string;
  transactions: number;
  categories: {
    category: string;
    id: string;
    count: number;
    share_percent: number;
  }[];
};

/** How a payee has been categorized in the past: the best evidence for suggesting a category. */
export function payeeCategoryHistory(
  rows: TxRow[],
  payees: string[],
): PayeeCategoryHistory[] {
  return payees.map(payee => {
    const key = normalizePayee(payee);
    const counts = new Map<string, { name: string; count: number }>();
    let total = 0;
    for (const row of rows) {
      if (row.category === null || row.isTransfer) continue;
      if (normalizePayee(row.payee) !== key) continue;
      const entry = counts.get(row.category) ?? {
        name: row.categoryName ?? row.category,
        count: 0,
      };
      entry.count += 1;
      counts.set(row.category, entry);
      total += 1;
    }
    return {
      payee,
      transactions: total,
      categories: [...counts.entries()]
        .map(([id, e]) => ({
          id,
          category: e.name,
          count: e.count,
          share_percent: total ? round((e.count / total) * 100, 1) : 0,
        }))
        .sort((a, b) => b.count - a.count),
    };
  });
}
