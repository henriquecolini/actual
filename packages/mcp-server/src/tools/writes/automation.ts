import * as api from '@actual-app/api';
import { z } from 'zod';

import { aql, internalSend } from '#api';
import { defineTool } from '#registry';
import { actionsFromMoney, amountFromMoney, conditionsFromMoney } from '#units';

const { q } = api;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const ruleValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.object({ num1: z.number(), num2: z.number() }),
]);

const condition = z.object({
  field: z.enum([
    'payee',
    'imported_payee',
    'notes',
    'amount',
    'account',
    'category',
    'category_group',
    'date',
    'cleared',
    'reconciled',
  ]),
  op: z.enum([
    'is',
    'isNot',
    'oneOf',
    'notOneOf',
    'contains',
    'doesNotContain',
    'matches',
    'hasTags',
    'gt',
    'gte',
    'lt',
    'lte',
    'isapprox',
    'isbetween',
    'onBudget',
    'offBudget',
  ]),
  value: ruleValue.optional(),
});

const action = z.object({
  field: z
    .enum([
      'category',
      'payee',
      'notes',
      'cleared',
      'account',
      'date',
      'amount',
    ])
    .optional()
    .describe('Not needed for set-split-amount or link-schedule'),
  op: z
    .enum(['set', 'prepend-notes', 'append-notes', 'link-schedule'])
    .default('set'),
  value: ruleValue,
});

const stage = z.enum(['pre', 'default', 'post']);
const RULE_NOTE =
  'Amounts in conditions are decimals (negative = money out), like every other tool. Ids come from list_categories, list_accounts and list_payees.';

type RuleLike = Parameters<typeof api.createRule>[0];

const recurrence = z.object({
  start: day,
  frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  interval: z.number().int().min(1).optional(),
  patterns: z
    .array(
      z.object({
        value: z.number().int(),
        type: z.enum(['day', 'SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']),
      }),
    )
    .optional()
    .describe(
      'E.g. {value: 15, type: "day"} = the 15th; {value: -1, type: "day"} = last day of the month',
    ),
  skipWeekend: z.boolean().optional(),
  weekendSolveMode: z.enum(['before', 'after']).optional(),
  endMode: z.enum(['never', 'after_n_occurrences', 'on_date']).optional(),
  endOccurrences: z.number().int().min(1).optional(),
  endDate: day.optional(),
});
const scheduleDate = z.union([day, recurrence]);
const amountOp = z.enum(['is', 'isapprox', 'isbetween']);

export const automationWriteTools = [
  defineTool({
    name: 'create_rule',
    write: true,
    description: `Create an automation rule that runs on new and imported transactions. stage "pre" runs first, "default" in the middle, "post" last. ${RULE_NOTE}`,
    shape: {
      stage: stage.optional(),
      conditions_op: z.enum(['and', 'or']).optional(),
      conditions: z.array(condition).min(1),
      actions: z.array(action).min(1),
    },
    handler: async ({ stage, conditions_op, conditions, actions }, ctx) => {
      const rule = await api.createRule({
        stage: stage ?? 'default',
        conditionsOp: conditions_op ?? 'and',
        conditions: conditionsFromMoney(conditions),
        actions: actionsFromMoney(withOp(actions)),
      } as unknown as RuleLike);
      await ctx.refresh();
      return { id: (rule as { id: string }).id };
    },
  }),

  defineTool({
    name: 'update_rule',
    write: true,
    description: `Change a rule. Send only what changes; conditions and actions, when given, replace the existing lists. ${RULE_NOTE}`,
    shape: {
      id: z.string(),
      stage: stage.optional(),
      conditions_op: z.enum(['and', 'or']).optional(),
      conditions: z.array(condition).min(1).optional(),
      actions: z.array(action).min(1).optional(),
    },
    handler: async ({ id, stage, conditions_op, conditions, actions }, ctx) => {
      const existing = (await api.getRules()).find(r => r.id === id);
      if (!existing) throw new Error(`No rule ${id}.`);
      await api.updateRule({
        ...existing,
        ...(stage ? { stage } : {}),
        ...(conditions_op ? { conditionsOp: conditions_op } : {}),
        ...(conditions ? { conditions: conditionsFromMoney(conditions) } : {}),
        ...(actions ? { actions: actionsFromMoney(withOp(actions)) } : {}),
      } as never);
      await ctx.refresh();
      return { ok: true };
    },
  }),

  defineTool({
    name: 'delete_rule',
    write: true,
    description:
      'Delete a rule. Transactions it already changed are not touched.',
    shape: { id: z.string() },
    handler: async ({ id }, ctx) => {
      await api.deleteRule(id);
      await ctx.refresh();
      return { ok: true };
    },
  }),

  defineTool({
    name: 'run_rules',
    write: true,
    description:
      'Apply the current rules to EXISTING transactions (rules normally only run on new ones), saving whatever they change. Scope with account_id, from/to dates, or only_uncategorized; up to 1000 transactions per call. Use dry_run first to see what would change. Splits and transfers are skipped.',
    shape: {
      account_id: z.string().optional(),
      from: day.optional(),
      to: day.optional(),
      only_uncategorized: z.boolean().optional(),
      dry_run: z.boolean().optional(),
    },
    handler: async (
      { account_id, from, to, only_uncategorized, dry_run },
      ctx,
    ) => {
      const filter: Record<string, unknown>[] = [
        { is_child: false },
        { is_parent: false },
        { 'payee.transfer_acct': null },
      ];
      if (account_id) filter.push({ account: account_id });
      if (from) filter.push({ date: { $gte: from } });
      if (to) filter.push({ date: { $lte: to } });
      if (only_uncategorized) filter.push({ category: null });

      const { data } = await aql<Record<string, unknown>[]>(
        q('transactions')
          .filter({ $and: filter })
          .select('*')
          .orderBy({ date: 'desc' })
          .limit(1000),
      );

      const COMPARED = [
        'category',
        'payee',
        'notes',
        'cleared',
        'amount',
        'date',
        'account',
      ];
      const changes: {
        id: string;
        date: unknown;
        changes: Record<string, { from: unknown; to: unknown }>;
      }[] = [];
      for (const row of data) {
        const result = await internalSend<Record<string, unknown>>(
          'rules-run',
          { transaction: row },
        );
        const diff: Record<string, { from: unknown; to: unknown }> = {};
        for (const key of COMPARED) {
          if ((row[key] ?? null) !== (result[key] ?? null)) {
            diff[key] = { from: row[key] ?? null, to: result[key] ?? null };
          }
        }
        if (Object.keys(diff).length) {
          changes.push({ id: String(row.id), date: row.date, changes: diff });
        }
      }

      if (!dry_run && changes.length) {
        await api.batchBudgetUpdates(async () => {
          for (const c of changes) {
            await api.updateTransaction(
              c.id,
              Object.fromEntries(
                Object.entries(c.changes).map(([k, v]) => [k, v.to]),
              ),
            );
          }
        });
        await ctx.refresh();
      }
      return {
        dry_run: dry_run ?? false,
        checked: data.length,
        changed: changes.length,
        // Amounts in the diff are cents, like the ids they refer to; keep the list short
        changes: changes.slice(0, 50),
        truncated: changes.length > 50,
      };
    },
  }),

  defineTool({
    name: 'create_schedule',
    write: true,
    description:
      'Create a scheduled/recurring transaction or bill. date is a single YYYY-MM-DD or a recurrence. Amounts are decimals (negative = money out); use amount_op "isapprox" for bills that vary slightly, or "isbetween" with amount_max. posts_transaction makes it enter itself automatically. Needs both an account and a payee.',
    shape: {
      name: z.string().optional(),
      date: scheduleDate,
      amount: z.number(),
      amount_max: z.number().optional(),
      amount_op: amountOp.optional(),
      account_id: z.string(),
      payee_id: z.string(),
      posts_transaction: z.boolean().optional(),
    },
    handler: async (args, ctx) => {
      const op =
        args.amount_op ?? (args.amount_max === undefined ? 'is' : 'isbetween');
      const amount = buildAmount(op, args.amount, args.amount_max);
      const id = await api.createSchedule({
        name: args.name,
        date: args.date,
        amount,
        amountOp: op,
        account: args.account_id,
        payee: args.payee_id,
        posts_transaction: args.posts_transaction ?? false,
      } as never);
      await ctx.refresh();
      return { id };
    },
  }),

  defineTool({
    name: 'update_schedule',
    write: true,
    description:
      'Change a schedule. Send only what changes. Set reset_next_date after changing the date/recurrence so the next due date is recalculated.',
    shape: {
      id: z.string(),
      name: z.string().optional(),
      date: scheduleDate.optional(),
      amount: z.number().optional(),
      amount_max: z.number().optional(),
      amount_op: amountOp.optional(),
      account_id: z.string().optional(),
      payee_id: z.string().optional(),
      posts_transaction: z.boolean().optional(),
      reset_next_date: z.boolean().optional(),
    },
    handler: async ({ id, reset_next_date, ...args }, ctx) => {
      const fields: Record<string, unknown> = {};
      if (args.name !== undefined) fields.name = args.name;
      if (args.date !== undefined) fields.date = args.date;
      if (args.account_id !== undefined) fields.account = args.account_id;
      if (args.payee_id !== undefined) fields.payee = args.payee_id;
      if (args.posts_transaction !== undefined) {
        fields.posts_transaction = args.posts_transaction;
      }
      if (args.amount_op !== undefined) fields.amountOp = args.amount_op;
      if (args.amount !== undefined) {
        const op =
          args.amount_op ??
          (args.amount_max === undefined ? undefined : 'isbetween');
        fields.amount = op
          ? buildAmount(op, args.amount, args.amount_max)
          : amountFromMoney(args.amount);
        if (op && fields.amountOp === undefined) fields.amountOp = op;
      }
      if (!Object.keys(fields).length) throw new Error('Nothing to update.');
      await api.updateSchedule(id, fields as never, reset_next_date);
      await ctx.refresh();
      return { ok: true };
    },
  }),

  defineTool({
    name: 'delete_schedule',
    write: true,
    description: 'Delete a schedule. Transactions it already created are kept.',
    shape: { id: z.string() },
    handler: async ({ id }, ctx) => {
      await api.deleteSchedule(id);
      await ctx.refresh();
      return { ok: true };
    },
  }),
];

function withOp<T extends { op?: string }>(actions: T[]) {
  return actions.map(a => ({ ...a, op: a.op ?? 'set' }));
}

function buildAmount(
  op: z.infer<typeof amountOp>,
  amount: number,
  amountMax: number | undefined,
) {
  if (op !== 'isbetween') return amountFromMoney(amount);
  if (amountMax === undefined) {
    throw new Error('amount_op "isbetween" needs amount_max.');
  }
  return amountFromMoney({
    num1: Math.min(amount, amountMax),
    num2: Math.max(amount, amountMax),
  });
}
