import * as api from '@actual-app/api';
import { z } from 'zod';

import { currencyCode, internalSend } from '#api';
import { fromMoney } from '#format';
import { defineTool } from '#registry';

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');
const source = z
  .string()
  .describe('A category id, or "to-budget" for the unassigned pool');

export const categoryWriteTools = [
  defineTool({
    name: 'update_category',
    write: true,
    description:
      'Rename a category or hide/unhide it. Use move_category to change its group or position and set_icon for icons.',
    shape: {
      id: z.string(),
      name: z.string().min(1).optional(),
      hidden: z.boolean().optional(),
    },
    handler: async ({ id, name, hidden }, ctx) => {
      const fields: { name?: string; hidden?: boolean } = {};
      if (name !== undefined) fields.name = name;
      if (hidden !== undefined) fields.hidden = hidden;
      if (!Object.keys(fields).length) throw new Error('Nothing to update.');
      await api.updateCategory(id, fields);
      await ctx.refresh();
      return { ok: true };
    },
  }),

  defineTool({
    name: 'delete_category',
    write: true,
    description:
      'Delete a category. If it has transactions or budget history, transfer_category_id is required: they are moved to that category (income categories can only transfer to income categories).',
    shape: { id: z.string(), transfer_category_id: z.string().optional() },
    handler: async ({ id, transfer_category_id }, ctx) => {
      await api.deleteCategory(id, transfer_category_id);
      await ctx.refresh();
      return { ok: true };
    },
  }),

  defineTool({
    name: 'move_category',
    write: true,
    description:
      'Move a category into a group (it may be a different group) and place it before another category of that group, or last when before_id is null.',
    shape: {
      id: z.string(),
      group_id: z.string(),
      before_id: z.string().nullable(),
    },
    handler: async ({ id, group_id, before_id }, ctx) => {
      await internalSend('category-move', {
        id,
        groupId: group_id,
        targetId: before_id,
      });
      await ctx.refresh();
      return { ok: true };
    },
  }),

  defineTool({
    name: 'create_category_group',
    write: true,
    description:
      'Create a category group (a heading that categories live under).',
    shape: { name: z.string().min(1), is_income: z.boolean().optional() },
    handler: async ({ name, is_income }, ctx) => {
      const id = await api.createCategoryGroup({
        name,
        is_income: is_income ?? false,
      } as never);
      await ctx.refresh();
      return { id };
    },
  }),

  defineTool({
    name: 'update_category_group',
    write: true,
    description: 'Rename a category group or hide/unhide it.',
    shape: {
      id: z.string(),
      name: z.string().min(1).optional(),
      hidden: z.boolean().optional(),
    },
    handler: async ({ id, name, hidden }, ctx) => {
      const fields: { name?: string; hidden?: boolean } = {};
      if (name !== undefined) fields.name = name;
      if (hidden !== undefined) fields.hidden = hidden;
      if (!Object.keys(fields).length) throw new Error('Nothing to update.');
      await api.updateCategoryGroup(id, fields);
      await ctx.refresh();
      return { ok: true };
    },
  }),

  defineTool({
    name: 'delete_category_group',
    write: true,
    description:
      'Delete a category group and every category in it. If those categories have transactions, transfer_category_id (a category outside the group) receives them.',
    shape: { id: z.string(), transfer_category_id: z.string().optional() },
    handler: async ({ id, transfer_category_id }, ctx) => {
      await api.deleteCategoryGroup(id, transfer_category_id);
      await ctx.refresh();
      return { ok: true };
    },
  }),

  defineTool({
    name: 'move_category_group',
    write: true,
    description:
      'Reorder a category group: place it before another group (before_id), or last when before_id is null.',
    shape: { id: z.string(), before_id: z.string().nullable() },
    handler: async ({ id, before_id }, ctx) => {
      await internalSend('category-group-move', { id, targetId: before_id });
      await ctx.refresh();
      return { ok: true };
    },
  }),

  defineTool({
    name: 'transfer_budget',
    write: true,
    description:
      'Move budgeted money (positive decimal) between two categories in a month, or to/from "to-budget". The budgeted amounts of both sides are adjusted and the move is noted on the month.',
    shape: { month, amount: z.number().positive(), from: source, to: source },
    handler: async ({ month, amount, from, to }, ctx) => {
      if (from === to) throw new Error('from and to must differ.');
      await internalSend('budget/transfer-category', {
        month,
        amount: fromMoney(amount),
        from,
        to,
        currencyCode: await currencyCode(),
      });
      await ctx.refresh();
      return { ok: true };
    },
  }),

  defineTool({
    name: 'cover_overspending',
    write: true,
    description:
      'Cover an overspent category by taking money from another category (or "to-budget"). Without amount it covers the whole overspending; amount is a positive decimal for a partial cover.',
    shape: {
      month,
      category_id: z.string().describe('The overspent category'),
      from: source,
      amount: z.number().positive().optional(),
    },
    handler: async ({ month, category_id, from, amount }, ctx) => {
      await internalSend('budget/cover-overspending', {
        month,
        to: category_id,
        from,
        amount: amount === undefined ? undefined : fromMoney(amount),
        currencyCode: await currencyCode(),
      });
      await ctx.refresh();
      return { ok: true };
    },
  }),

  defineTool({
    name: 'cover_overbudgeted',
    write: true,
    description:
      'Fix a negative "To Budget" (more budgeted than income) by taking money back from a category. Without amount it takes exactly what is needed.',
    shape: {
      month,
      category_id: z.string(),
      amount: z.number().positive().optional(),
    },
    handler: async ({ month, category_id, amount }, ctx) => {
      await internalSend('budget/cover-overbudgeted', {
        month,
        category: category_id,
        amount: amount === undefined ? undefined : fromMoney(amount),
        currencyCode: await currencyCode(),
      });
      await ctx.refresh();
      return { ok: true };
    },
  }),

  defineTool({
    name: 'set_carryover',
    write: true,
    description:
      'Turn rollover of a category balance on or off from a month onward. With it on, an overspent balance also carries into the next month instead of being deducted from To Budget.',
    shape: { month, category_id: z.string(), enabled: z.boolean() },
    handler: async ({ month, category_id, enabled }, ctx) => {
      await api.setBudgetCarryover(month, category_id, enabled);
      await ctx.refresh();
      return { ok: true };
    },
  }),

  defineTool({
    name: 'hold_budget_for_next_month',
    write: true,
    description:
      "Hold part of this month's To Budget (positive decimal) so it is not available until next month.",
    shape: { month, amount: z.number().positive() },
    handler: async ({ month, amount }, ctx) => {
      await api.holdBudgetForNextMonth(month, fromMoney(amount));
      await ctx.refresh();
      return { ok: true };
    },
  }),

  defineTool({
    name: 'reset_budget_hold',
    write: true,
    description: 'Release money held for next month back into To Budget.',
    shape: { month },
    handler: async ({ month }, ctx) => {
      await api.resetBudgetHold(month);
      await ctx.refresh();
      return { ok: true };
    },
  }),
];
