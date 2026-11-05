import { z } from 'zod';

import {
  detectRecurring,
  findAnomalies,
  findDuplicates,
  incomeVsExpense,
  monthlySeries,
  netWorthSeries,
  payeeCategoryHistory,
  spendingBy,
  summarizeUncategorized,
} from '#analysis';
import { budgetMonth } from '#api';
import { loadTransactions } from '#data';
import {
  addMonths,
  currentMonth,
  isDay,
  lastDayOfMonth,
  monthsBetween,
  round,
  toMoney,
} from '#format';
import { defineTool } from '#registry';

const day = z.string().refine(isDay, 'Expected YYYY-MM-DD');
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected YYYY-MM');

export const analysisTools = [
  defineTool({
    name: 'spending_by',
    description:
      'Where the money went in a period: net spending grouped by category, category group, payee or month, largest first, with share of total. Excludes transfers, income and off-budget accounts by default; refunds reduce spending.',
    shape: {
      start_date: day,
      end_date: day,
      group_by: z.enum(['category', 'group', 'payee', 'month']).optional(),
      top_n: z.number().int().min(1).max(100).optional(),
      include_off_budget: z.boolean().optional(),
    },
    handler: async args => {
      const rows = await loadTransactions({
        startDate: args.start_date,
        endDate: args.end_date,
        includeTransfers: true,
      });
      return {
        period: `${args.start_date} to ${args.end_date}`,
        group_by: args.group_by ?? 'category',
        ...spendingBy(rows, args.group_by ?? 'category', {
          topN: args.top_n,
          includeOffBudget: args.include_off_budget,
        }),
      };
    },
  }),

  defineTool({
    name: 'income_vs_expense',
    description:
      'Month by month income, expenses, net and savings rate between two months (YYYY-MM, inclusive). Excludes transfers and starting balances.',
    shape: {
      start_month: month,
      end_month: month,
      include_off_budget: z.boolean().optional(),
    },
    handler: async args => {
      const months = monthsBetween(args.start_month, args.end_month);
      const rows = await loadTransactions({
        startDate: `${args.start_month}-01`,
        endDate: lastDayOfMonth(args.end_month),
        includeTransfers: true,
      });
      const summary = incomeVsExpense(rows, months, {
        includeOffBudget: args.include_off_budget,
      });
      const income = summary.reduce((t, m) => t + m.income, 0);
      const expenses = summary.reduce((t, m) => t + m.expenses, 0);
      return {
        months: summary,
        totals: {
          income: round(income),
          expenses: round(expenses),
          net: round(income - expenses),
          savings_rate_percent:
            income > 0 ? round(((income - expenses) / income) * 100, 1) : null,
        },
      };
    },
  }),

  defineTool({
    name: 'category_trend',
    description:
      'Monthly spending for one category, one category group, or one payee over the last N months (default 12), with the average. Provide exactly one of category_id, group_name or payee.',
    shape: {
      category_id: z.string().optional(),
      group_name: z.string().optional(),
      payee: z.string().optional(),
      months: z.number().int().min(2).max(60).optional(),
    },
    handler: async args => {
      const count = args.months ?? 12;
      const end = currentMonth();
      const start = addMonths(end, -(count - 1));
      const months = monthsBetween(start, end);
      const rows = await loadTransactions({
        startDate: `${start}-01`,
        endDate: lastDayOfMonth(end),
        includeTransfers: true,
      });
      const wanted = args.payee?.toLowerCase();
      const series = monthlySeries(rows, months, r =>
        args.category_id
          ? r.category === args.category_id
          : args.group_name
            ? r.categoryGroup === args.group_name
            : wanted
              ? (r.payee ?? '').toLowerCase().includes(wanted)
              : true,
      );
      const complete = series.slice(0, -1); // the current month is still in progress
      const average =
        complete.length > 0
          ? complete.reduce((t, m) => t + m.total, 0) / complete.length
          : 0;
      return {
        months: series,
        average_per_complete_month: round(average),
        note: 'The last entry is the current, incomplete month.',
      };
    },
  }),

  defineTool({
    name: 'net_worth_over_time',
    description:
      'Net worth at the end of each of the last N months (default 12), split into on-budget and off-budget accounts.',
    shape: { months: z.number().int().min(2).max(120).optional() },
    handler: async ({ months: count }) => {
      const end = currentMonth();
      const months = monthsBetween(addMonths(end, -((count ?? 12) - 1)), end);
      const rows = await loadTransactions({ includeTransfers: true });
      return { series: netWorthSeries(rows, months) };
    },
  }),

  defineTool({
    name: 'uncategorized_summary',
    description:
      'How many transactions still have no category, how much they total, the oldest, and the payees that account for most of them (with sample transaction ids). The starting point for categorization work.',
    shape: { top_payees: z.number().int().min(1).max(100).optional() },
    handler: async ({ top_payees }) => {
      const rows = await loadTransactions({ uncategorized: true });
      return summarizeUncategorized(rows, top_payees ?? 30);
    },
  }),

  defineTool({
    name: 'payee_category_history',
    description:
      'For each payee name, how its past transactions were categorized (counts and share). This is the best evidence when suggesting a category for an uncategorized transaction.',
    shape: { payees: z.array(z.string()).min(1).max(50) },
    handler: async ({ payees }) => {
      const rows = await loadTransactions({ includeTransfers: false });
      return payeeCategoryHistory(rows, payees);
    },
  }),

  defineTool({
    name: 'find_recurring',
    description:
      'Detects recurring payments and income (subscriptions, bills, salary) from the last N months of history (default 12): cadence, typical amount, next expected date and annualized cost. Ordered by yearly cost.',
    shape: {
      months: z.number().int().min(3).max(36).optional(),
      min_occurrences: z.number().int().min(2).max(12).optional(),
    },
    handler: async args => {
      const end = currentMonth();
      const start = addMonths(end, -((args.months ?? 12) - 1));
      const rows = await loadTransactions({
        startDate: `${start}-01`,
        includeTransfers: true,
      });
      const items = detectRecurring(rows, {
        minOccurrences: args.min_occurrences,
      });
      const yearlyExpense = items
        .filter(i => i.direction === 'expense')
        .reduce((t, i) => t + i.annualized, 0);
      return {
        items,
        annualized_recurring_expenses: round(yearlyExpense),
      };
    },
  }),

  defineTool({
    name: 'find_duplicates',
    description:
      'Possible duplicate transactions: same account, amount and payee within a few days (default 2). Often from importing the same file twice.',
    shape: {
      start_date: day.optional(),
      end_date: day.optional(),
      max_days_apart: z.number().int().min(0).max(7).optional(),
    },
    handler: async args => {
      const rows = await loadTransactions({
        startDate: args.start_date,
        endDate: args.end_date,
      });
      const pairs = findDuplicates(rows, { maxDaysApart: args.max_days_apart });
      return { count: pairs.length, pairs: pairs.slice(0, 100) };
    },
  }),

  defineTool({
    name: 'find_anomalies',
    description:
      'Unusual spending: categories whose spend in a recent month is far above their own history, and single transactions much larger than that payee normally charges. Looks at the last N months (default 2).',
    shape: {
      months: z.number().int().min(1).max(6).optional(),
      min_amount: z
        .number()
        .optional()
        .describe('Ignore differences smaller than this (default 50)'),
    },
    handler: async args => {
      const end = currentMonth();
      const recent = monthsBetween(
        addMonths(end, -((args.months ?? 2) - 1)),
        end,
      );
      const start = addMonths(recent[0], -6);
      const rows = await loadTransactions({
        startDate: `${start}-01`,
        endDate: lastDayOfMonth(end),
      });
      return findAnomalies(rows, recent, { minAmount: args.min_amount });
    },
  }),

  defineTool({
    name: 'budget_health',
    description:
      "A health check of one month's budget (default: the current month): overspent categories, spending in categories with no budget, money left to budget, budgets far from actual 3-month spending, and uncategorized transactions. Returns findings with a severity.",
    shape: { month: month.optional() },
    handler: async args => {
      const target = args.month ?? currentMonth();
      const data = await budgetMonth(target);
      const history = monthsBetween(
        addMonths(target, -3),
        addMonths(target, -1),
      );
      const past = await Promise.all(history.map(m => budgetMonth(m)));

      type Finding = {
        severity: 'high' | 'medium' | 'low';
        kind: string;
        message: string;
        category?: string;
        amount?: number;
      };
      const findings: Finding[] = [];

      if (data.toBudget < 0) {
        findings.push({
          severity: 'high',
          kind: 'over_budgeted',
          message: `More is budgeted than is available: ${toMoney(data.toBudget)} left to budget.`,
          amount: toMoney(data.toBudget),
        });
      } else if (data.toBudget > 0) {
        findings.push({
          severity: 'low',
          kind: 'unassigned_money',
          message: `${toMoney(data.toBudget)} is still unassigned (to budget).`,
          amount: toMoney(data.toBudget),
        });
      }
      if (data.lastMonthOverspent < 0) {
        findings.push({
          severity: 'medium',
          kind: 'overspending_carried_in',
          message: `Last month's overspending of ${toMoney(-data.lastMonthOverspent)} is reducing this month.`,
          amount: toMoney(data.lastMonthOverspent),
        });
      }

      for (const group of data.categoryGroups) {
        if (group.is_income || group.hidden) continue;
        for (const cat of group.categories ?? []) {
          if (cat.hidden) continue;
          const spent = -cat.spent;
          if (cat.balance < 0 && !cat.carryover) {
            findings.push({
              severity: 'high',
              kind: 'overspent',
              category: cat.name,
              message: `${cat.name} is overspent by ${toMoney(-cat.balance)} (budgeted ${toMoney(cat.budgeted)}, spent ${toMoney(spent)}).`,
              amount: toMoney(cat.balance),
            });
          } else if (cat.budgeted === 0 && spent > 0) {
            findings.push({
              severity: 'medium',
              kind: 'unbudgeted_spending',
              category: cat.name,
              message: `${cat.name} has ${toMoney(spent)} of spending but nothing budgeted.`,
              amount: toMoney(spent),
            });
          }

          const pastSpend = past
            .map(m =>
              m.categoryGroups
                .flatMap(g => g.categories ?? [])
                .find(c => c.id === cat.id),
            )
            .filter(Boolean)
            .map(c => -c!.spent);
          if (pastSpend.length === 3 && cat.budgeted > 0) {
            const avg = pastSpend.reduce((a, b) => a + b, 0) / 3;
            if (avg > cat.budgeted * 1.3 && avg - cat.budgeted > 2000) {
              findings.push({
                severity: 'medium',
                kind: 'budget_below_trend',
                category: cat.name,
                message: `${cat.name} is budgeted ${toMoney(cat.budgeted)} but averages ${toMoney(avg)} over the last 3 months.`,
                amount: toMoney(avg - cat.budgeted),
              });
            } else if (avg < cat.budgeted * 0.5 && cat.budgeted - avg > 2000) {
              findings.push({
                severity: 'low',
                kind: 'budget_above_trend',
                category: cat.name,
                message: `${cat.name} is budgeted ${toMoney(cat.budgeted)} but averages only ${toMoney(avg)}; money could be freed.`,
                amount: toMoney(cat.budgeted - avg),
              });
            }
          }
        }
      }

      const uncategorized = await loadTransactions({
        uncategorized: true,
        startDate: `${target}-01`,
        endDate: lastDayOfMonth(target),
      });
      if (uncategorized.length > 0) {
        findings.push({
          severity: uncategorized.length > 10 ? 'medium' : 'low',
          kind: 'uncategorized',
          message: `${uncategorized.length} transactions in ${target} have no category.`,
        });
      }

      const order = { high: 0, medium: 1, low: 2 };
      findings.sort((a, b) => order[a.severity] - order[b.severity]);
      return {
        month: target,
        summary: {
          budgeted: toMoney(data.totalBudgeted),
          spent: toMoney(data.totalSpent),
          income: toMoney(data.totalIncome),
          to_budget: toMoney(data.toBudget),
        },
        findings,
      };
    },
  }),
];
