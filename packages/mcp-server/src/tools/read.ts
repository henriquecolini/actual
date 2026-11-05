import * as api from '@actual-app/api';
import { z } from 'zod';

import { aql, budgetMonth, internalSend } from '#api';
import { queryTransactions } from '#data';
import { fromMoney, today, toMoney } from '#format';
import { defineTool } from '#registry';
import { actionsToMoney, amountToMoney, conditionsToMoney } from '#units';

const { q } = api;

// Tables the model may query with run_query. Mirrors the AQL schema.
export const QUERYABLE_TABLES = [
  'transactions',
  'accounts',
  'categories',
  'category_groups',
  'payees',
  'rules',
  'schedules',
  'tags',
] as const;

export const SCHEMA_HELP = {
  amounts:
    'All amount fields are integer cents (1234 = 12.34). Negative = money out.',
  filters:
    'Filter objects use AQL operators: {date: {$gte: "2026-01-01", $lte: "2026-01-31"}}, {amount: {$lt: 0}}, {category: null}, {"payee.name": {$like: "%uber%"}}, {$or: [...]}, {category: {$oneof: [ids]}}.',
  transactions: [
    'id',
    'date (YYYY-MM-DD)',
    'amount',
    'account / account.name / account.offbudget',
    'payee / payee.name',
    'category / category.name / category.group.name / category.is_income',
    'notes',
    'cleared',
    'reconciled',
    'payee.transfer_acct (set when the payee is another account, i.e. a transfer)',
    'transfer_id (links the two sides of a transfer)',
    'imported_payee',
  ],
  accounts: ['id', 'name', 'offbudget', 'closed', 'sort_order'],
  categories: [
    'id',
    'name',
    'is_income',
    'hidden',
    'group',
    'group.name',
    'icon',
    'icon_color',
  ],
  category_groups: ['id', 'name', 'is_income', 'hidden'],
  payees: ['id', 'name', 'transfer_acct'],
  aggregates:
    'select can contain {total: {$sum: "$amount"}}, {n: {$count: "$id"}}, {avg: {$avg: "$amount"}}; use group_by with them.',
};

const aqlValue = z.record(z.string(), z.unknown());

export const readTools = [
  defineTool({
    name: 'get_overview',
    description:
      "START HERE. A snapshot of the budget: currency, budget type, accounts and balances, date range of the data, how many transactions are uncategorized, and today's date.",
    shape: {},
    handler: async () => {
      const [accounts, prefs, categories, version] = await Promise.all([
        api.getAccounts(),
        api.getPreferences().catch(() => ({})),
        api.getCategories(),
        api.getServerVersion().catch(() => null),
      ]);
      const balances = await accountBalances();
      const open = accounts.filter(a => !a.closed);
      const sum = (offbudget: boolean) =>
        open
          .filter(a => Boolean(a.offbudget) === offbudget)
          .reduce((total, a) => total + (balances.get(a.id) ?? 0), 0);

      const count = await aql(q('transactions').calculate({ $count: '$id' }));
      const [first] = (
        await aql(q('transactions').select(['date']).orderBy('date').limit(1))
      ).data as { date: string }[];
      const [last] = (
        await aql(
          q('transactions').select(['date']).orderBy({ date: 'desc' }).limit(1),
        )
      ).data as { date: string }[];
      const uncategorized = await aql(
        q('transactions')
          .filter({
            category: null,
            'payee.transfer_acct': null,
            'account.offbudget': false,
          })
          .calculate({ $count: '$id' }),
      );

      const p = prefs as Record<string, string | undefined>;
      return {
        today: today(),
        server_version: version,
        currency: p.defaultCurrencyCode ?? null,
        budget_type: p.budgetType ?? 'envelope',
        accounts: {
          open: open.length,
          closed: accounts.length - open.length,
          on_budget_total: toMoney(sum(false)),
          off_budget_total: toMoney(sum(true)),
        },
        categories: categories.filter(c => !c.hidden).length,
        transactions: {
          total: Number(count.data),
          first_date: first?.date ?? null,
          last_date: last?.date ?? null,
          uncategorized: Number(uncategorized.data),
        },
        note: 'Amounts are plain decimal numbers in the budget currency.',
      };
    },
  }),

  defineTool({
    name: 'list_accounts',
    description:
      'All accounts with their current balance, whether they are off-budget (tracking only, e.g. investments, mortgage) and whether they are closed.',
    shape: { include_closed: z.boolean().optional() },
    handler: async ({ include_closed }) => {
      const [accounts, balances] = await Promise.all([
        api.getAccounts(),
        accountBalances(),
      ]);
      return accounts
        .filter(a => include_closed || !a.closed)
        .map(a => ({
          id: a.id,
          name: a.name,
          off_budget: Boolean(a.offbudget),
          closed: Boolean(a.closed),
          balance: toMoney(balances.get(a.id) ?? 0),
        }));
    },
  }),

  defineTool({
    name: 'list_categories',
    description:
      'Category groups and their categories (ids are needed for other tools). Income categories are flagged.',
    shape: { include_hidden: z.boolean().optional() },
    handler: async ({ include_hidden }) => {
      const groups = await api.getCategoryGroups();
      return groups
        .filter(g => include_hidden || !g.hidden)
        .map(g => ({
          id: g.id,
          name: g.name,
          is_income: Boolean(g.is_income),
          hidden: Boolean(g.hidden),
          categories: (g.categories ?? [])
            .filter(c => include_hidden || !c.hidden)
            .map(c => ({
              id: c.id,
              name: c.name,
              hidden: Boolean(c.hidden),
              icon: c.icon ?? null,
            })),
        }));
    },
  }),

  defineTool({
    name: 'get_budget_month',
    description:
      'The budget for one month: per category budgeted, spent and balance (carryover flagged), plus totals, to-budget and overspending carried in. Month is YYYY-MM.',
    shape: { month: z.string().regex(/^\d{4}-\d{2}$/) },
    handler: async ({ month }) => {
      const data = await budgetMonth(month);
      return {
        month: data.month,
        to_budget: toMoney(data.toBudget),
        total_budgeted: toMoney(data.totalBudgeted),
        total_income: toMoney(data.totalIncome),
        total_spent: toMoney(data.totalSpent),
        total_balance: toMoney(data.totalBalance),
        from_last_month: toMoney(data.fromLastMonth),
        last_month_overspent: toMoney(data.lastMonthOverspent),
        for_next_month: toMoney(data.forNextMonth),
        groups: data.categoryGroups
          .filter(g => !g.hidden)
          .map(g => ({
            name: g.name,
            is_income: Boolean(g.is_income),
            budgeted: toMoney(g.budgeted),
            spent: toMoney(g.spent),
            balance: toMoney(g.balance),
            categories: (g.categories ?? [])
              .filter(c => !c.hidden)
              .map(c => ({
                id: c.id,
                name: c.name,
                budgeted: toMoney(c.budgeted),
                spent: toMoney(c.spent),
                balance: toMoney(c.balance),
                carryover: Boolean(c.carryover),
              })),
          })),
      };
    },
  }),

  defineTool({
    name: 'list_budget_months',
    description: 'The months that exist in the budget (YYYY-MM).',
    shape: {},
    handler: async () => api.getBudgetMonths(),
  }),

  defineTool({
    name: 'search_transactions',
    description:
      'Find transactions. All filters are optional and combine with AND. Newest first. Transfers between accounts are excluded unless include_transfers is true. Returns up to `limit` rows (default 100, max 500) and the total number of matches.',
    shape: {
      start_date: z.string().optional().describe('YYYY-MM-DD, inclusive'),
      end_date: z.string().optional().describe('YYYY-MM-DD, inclusive'),
      account_id: z.string().optional(),
      category_id: z.string().optional(),
      uncategorized: z
        .boolean()
        .optional()
        .describe('Only transactions without a category'),
      text: z.string().optional().describe('Matches payee name or notes'),
      min_amount: z
        .number()
        .optional()
        .describe(
          'Decimal, signed: money out is negative. -50 as max_amount finds spending of 50 or more.',
        ),
      max_amount: z.number().optional(),
      include_transfers: z.boolean().optional(),
      limit: z.number().int().min(1).max(500).optional(),
      offset: z.number().int().min(0).optional(),
    },
    handler: async args => {
      const limit = args.limit ?? 100;
      const { rows, total } = await queryTransactions(
        {
          startDate: args.start_date,
          endDate: args.end_date,
          accountId: args.account_id,
          categoryId: args.category_id,
          uncategorized: args.uncategorized,
          text: args.text,
          minAmount:
            args.min_amount === undefined
              ? undefined
              : fromMoney(args.min_amount),
          maxAmount:
            args.max_amount === undefined
              ? undefined
              : fromMoney(args.max_amount),
          includeTransfers: args.include_transfers,
        },
        { limit, offset: args.offset },
      );
      return {
        total_matches: total,
        returned: rows.length,
        transactions: rows.map(r => ({
          id: r.id,
          date: r.date,
          amount: toMoney(r.amount),
          account: r.accountName,
          payee: r.payee,
          category: r.categoryName,
          category_id: r.category,
          notes: r.notes,
          cleared: r.cleared,
          transfer: r.isTransfer || undefined,
        })),
      };
    },
  }),

  defineTool({
    name: 'list_payees',
    description:
      'Payees ordered by how often they appear, with transaction count and total spent. Useful for spotting messy or duplicate payee names.',
    shape: { limit: z.number().int().min(1).max(500).optional() },
    handler: async ({ limit }) => {
      const { data } = await aql(
        q('transactions')
          .filter({ 'payee.transfer_acct': null })
          .groupBy('payee.name')
          .select([
            'payee.name',
            { n: { $count: '$id' } },
            { total: { $sum: '$amount' } },
          ])
          .orderBy({ n: 'desc' })
          .limit(limit ?? 100),
      );
      return (data as Record<string, unknown>[]).map(r => ({
        payee: r['payee.name'] ?? '(no payee)',
        transactions: r.n,
        total: toMoney(Number(r.total)),
      }));
    },
  }),

  defineTool({
    name: 'list_rules',
    description:
      'Automation rules (conditions and actions) that run on transactions. Amounts are decimals.',
    shape: {},
    handler: async () => {
      const rules = await api.getRules();
      return rules.map(r => ({
        id: r.id,
        stage: r.stage,
        conditions_op: r.conditionsOp,
        conditions: conditionsToMoney(r.conditions),
        actions: actionsToMoney(r.actions),
      }));
    },
  }),

  defineTool({
    name: 'list_schedules',
    description:
      'Scheduled/recurring transactions and bills with their next due date.',
    shape: {},
    handler: async () => {
      const schedules = await api.getSchedules();
      return schedules.map(s => ({
        id: s.id,
        name: s.name,
        next_date: s.next_date,
        completed: s.completed,
        posts_transaction: s.posts_transaction,
        amount: amountToMoney(s.amount),
        amount_op: s.amountOp,
        account: s.account,
        payee: s.payee,
      }));
    },
  }),

  defineTool({
    name: 'list_account_groups',
    description: 'Groups the accounts are organised in (sidebar sections).',
    shape: {},
    handler: async () => api.getAccountGroups(),
  }),

  defineTool({
    name: 'list_reports',
    description:
      'Saved custom reports (charts and tables on the Reports page) and their settings.',
    shape: {},
    handler: async () => internalSend('report/get'),
  }),

  defineTool({
    name: 'list_tags',
    description: 'Tags defined in the budget.',
    shape: {},
    handler: async () => api.getTags(),
  }),

  defineTool({
    name: 'get_notes',
    description:
      'Notes the user wrote. Ids: "category-<id>", "account-<id>", "budget-<YYYY-MM>". Category notes often hold goals or instructions.',
    shape: { id: z.string() },
    handler: async ({ id }) => {
      const found = await api.getNote(id);
      return { id, note: found?.note ?? null };
    },
  }),

  defineTool({
    name: 'describe_schema',
    description: 'Tables, fields and filter syntax for run_query.',
    shape: {},
    handler: async () => ({ tables: QUERYABLE_TABLES, ...SCHEMA_HELP }),
  }),

  defineTool({
    name: 'run_query',
    description:
      'Run a read-only ActualQL query for anything the other tools do not cover. Call describe_schema first. Amounts are integer cents. Example: {table:"transactions", filter:{date:{$gte:"2026-01-01"}}, group_by:["category.name"], select:["category.name",{total:{$sum:"$amount"}}], order_by:[{total:"asc"}], limit:20}.',
    shape: {
      table: z.enum(QUERYABLE_TABLES),
      filter: aqlValue.optional(),
      select: z.array(z.union([z.string(), aqlValue])).optional(),
      group_by: z.array(z.string()).optional(),
      order_by: z
        .array(z.union([z.string(), z.record(z.string(), z.string())]))
        .optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    },
    handler: async args => {
      let query = q(args.table);
      if (args.filter) query = query.filter(args.filter);
      if (args.group_by?.length) query = query.groupBy(args.group_by);
      query = query.select(args.select?.length ? args.select : ['*']);
      if (args.order_by?.length) query = query.orderBy(args.order_by);
      query = query.limit(args.limit ?? 200);
      const { data } = await aql(query);
      return { rows: data };
    },
  }),

  defineTool({
    name: 'refresh_data',
    description:
      'Pull the latest changes from the sync server. Only needed if the user says they just changed something; data is refreshed automatically otherwise.',
    shape: {},
    handler: async (_args, ctx) => {
      await ctx.refresh();
      return { ok: true };
    },
  }),
];

async function accountBalances(): Promise<Map<string, number>> {
  const { data } = await aql(
    q('transactions')
      .groupBy('account')
      .select(['account', { total: { $sum: '$amount' } }]),
  );
  return new Map(
    (data as { account: string; total: number }[]).map(r => [
      r.account,
      Number(r.total),
    ]),
  );
}
