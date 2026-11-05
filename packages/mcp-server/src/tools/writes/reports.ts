import { z } from 'zod';

import { internalSend } from '#api';
import { defineTool } from '#registry';

// Custom reports are the saved charts on the Reports page. The tools expose the
// options that matter and fill the rest with the same defaults the app uses.

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const options = {
  group_by: z
    .enum([
      'Category',
      'Group',
      'Payee',
      'Account',
      'Month',
      'Year',
      'Interval',
    ])
    .optional(),
  graph_type: z
    .enum([
      'TableGraph',
      'BarGraph',
      'LineGraph',
      'StackedBarGraph',
      'AreaGraph',
      'DonutGraph',
    ])
    .optional(),
  interval: z.enum(['Daily', 'Weekly', 'Monthly', 'Yearly']).optional(),
  balance_type: z
    .enum([
      'Payment',
      'Deposit',
      'Net',
      'Net Payment',
      'Net Deposit',
      'Budgeted',
    ])
    .optional()
    .describe('Payment = spending, Deposit = income, Net = both'),
  mode: z.enum(['total', 'time']).optional(),
  date_range: z
    .string()
    .optional()
    .describe(
      'A relative range such as "Last 6 months", "This month", "Year to date". Ignored when start_date and end_date are given.',
    ),
  start_date: day.optional(),
  end_date: day.optional(),
  conditions: z
    .array(
      z.object({
        field: z.enum([
          'account',
          'category',
          'category_group',
          'payee',
          'notes',
          'imported_payee',
          'amount',
          'date',
        ]),
        op: z.string().describe('For example is, oneOf, contains'),
        value: z.union([z.string(), z.number(), z.array(z.string())]),
      }),
    )
    .optional()
    .describe(
      'Which transactions the report includes. Amounts here are cents.',
    ),
  conditions_op: z.enum(['and', 'or']).optional(),
  show_empty: z.boolean().optional(),
  show_off_budget: z.boolean().optional(),
  show_hidden_categories: z.boolean().optional(),
  show_uncategorized: z.boolean().optional(),
};

type ReportOptions = {
  [K in keyof typeof options]?: z.infer<(typeof options)[K]>;
};

const DEFAULTS = {
  startDate: '',
  endDate: '',
  isDateStatic: false,
  dateRange: 'Last 6 months',
  mode: 'total',
  groupBy: 'Category',
  tagScope: { mode: 'all' },
  interval: 'Monthly',
  balanceType: 'Payment',
  sortBy: 'desc',
  showEmpty: false,
  showOffBudget: false,
  showHiddenCategories: true,
  includeCurrentInterval: true,
  showUncategorized: true,
  trimIntervals: false,
  showTrendLines: false,
  graphType: 'BarGraph',
  conditions: [],
  conditionsOp: 'and',
};

function fromOptions(o: ReportOptions): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    groupBy: o.group_by,
    graphType: o.graph_type,
    interval: o.interval,
    balanceType: o.balance_type,
    mode: o.mode,
    dateRange: o.date_range,
    conditions: o.conditions,
    conditionsOp: o.conditions_op,
    showEmpty: o.show_empty,
    showOffBudget: o.show_off_budget,
    showHiddenCategories: o.show_hidden_categories,
    showUncategorized: o.show_uncategorized,
  };
  if (o.start_date && o.end_date) {
    fields.startDate = o.start_date;
    fields.endDate = o.end_date;
    fields.isDateStatic = true;
  } else if (o.start_date || o.end_date) {
    throw new Error('Give both start_date and end_date, or neither.');
  }
  return Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== undefined),
  );
}

export const reportWriteTools = [
  defineTool({
    name: 'create_report',
    write: true,
    description:
      'Save a custom report (chart/table on the Reports page). Unspecified options default to a 6-month monthly spending-by-category bar chart. Names must be unique.',
    shape: { name: z.string().min(1), ...options },
    handler: async ({ name, ...rest }, ctx) => {
      const id = await internalSend<string>('report/create', {
        ...DEFAULTS,
        ...fromOptions(rest),
        id: '',
        name,
      });
      await ctx.refresh();
      return { id };
    },
  }),

  defineTool({
    name: 'update_report',
    write: true,
    description:
      'Change a saved report. Send only the options that change; see list_reports for the current ones.',
    shape: { id: z.string(), name: z.string().min(1).optional(), ...options },
    handler: async ({ id, name, ...rest }, ctx) => {
      const reports = await internalSend<{ id: string }[]>('report/get');
      const existing = reports.find(r => r.id === id);
      if (!existing) throw new Error(`No report ${id}.`);
      await internalSend('report/update', {
        ...existing,
        ...fromOptions(rest),
        ...(name ? { name } : {}),
      });
      await ctx.refresh();
      return { ok: true };
    },
  }),

  defineTool({
    name: 'delete_report',
    write: true,
    description: 'Delete a saved custom report.',
    shape: { id: z.string() },
    handler: async ({ id }, ctx) => {
      await internalSend('report/delete', id);
      await ctx.refresh();
      return { ok: true };
    },
  }),
];
