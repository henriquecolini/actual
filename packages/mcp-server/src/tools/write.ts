import * as api from '@actual-app/api';
import { z } from 'zod';

import { fromMoney } from '#format';
import { defineTool } from '#registry';

import { accountWriteTools } from './writes/accounts';
import { automationWriteTools } from './writes/automation';
import { categoryWriteTools } from './writes/categories';
import { payeeWriteTools } from './writes/payees';
import { reportWriteTools } from './writes/reports';
import { transactionWriteTools } from './writes/transactions';

// Only registered with ACTUAL_MCP_WRITE=1 (external clients such as Claude
// Code on a desktop). The in-app assistant never gets these: it proposes.

export const writeTools = [
  defineTool({
    name: 'update_transactions',
    write: true,
    description:
      'Change the category, notes, cleared flag, date, amount or payee of existing transactions (up to 100 per call). Changes are synced to the server immediately.',
    shape: {
      updates: z
        .array(
          z.object({
            id: z.string(),
            category_id: z.string().nullable().optional(),
            notes: z.string().optional(),
            cleared: z.boolean().optional(),
            date: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/)
              .optional(),
            amount: z.number().optional().describe('Decimal; not for splits'),
            payee_id: z.string().nullable().optional(),
          }),
        )
        .min(1)
        .max(100),
    },
    handler: async ({ updates }, ctx) => {
      await api.batchBudgetUpdates(async () => {
        for (const update of updates) {
          const fields: Record<string, unknown> = {};
          if (update.category_id !== undefined) {
            fields.category = update.category_id;
          }
          if (update.notes !== undefined) fields.notes = update.notes;
          if (update.cleared !== undefined) fields.cleared = update.cleared;
          if (update.date !== undefined) fields.date = update.date;
          if (update.amount !== undefined) {
            fields.amount = fromMoney(update.amount);
          }
          if (update.payee_id !== undefined) fields.payee = update.payee_id;
          await api.updateTransaction(update.id, fields);
        }
      });
      await ctx.refresh();
      return { updated: updates.length };
    },
  }),

  defineTool({
    name: 'set_budget_amount',
    write: true,
    description:
      'Set the budgeted amount (decimal) of a category in a month (YYYY-MM).',
    shape: {
      month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
      category_id: z.string(),
      amount: z.number().min(0),
    },
    handler: async ({ month, category_id, amount }, ctx) => {
      await api.setBudgetAmount(month, category_id, fromMoney(amount));
      await ctx.refresh();
      return { ok: true };
    },
  }),

  defineTool({
    name: 'create_category',
    write: true,
    description: 'Create a category inside an existing category group.',
    shape: { name: z.string().min(1), group_id: z.string() },
    handler: async ({ name, group_id }, ctx) => {
      const id = await api.createCategory({ name, group_id });
      await ctx.refresh();
      return { id };
    },
  }),

  defineTool({
    name: 'set_icon',
    write: true,
    description:
      'Set the icon ("tabler:<name>" or "bank:<slug>") and background color (#rrggbb) of a category or account.',
    shape: {
      kind: z.enum(['category', 'account']),
      id: z.string(),
      icon: z.string().nullable(),
      color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .nullable(),
    },
    handler: async ({ kind, id, icon, color }, ctx) => {
      const fields = { icon, icon_color: color };
      if (kind === 'category') await api.updateCategory(id, fields);
      else await api.updateAccount(id, fields);
      await ctx.refresh();
      return { ok: true };
    },
  }),

  ...transactionWriteTools,
  ...accountWriteTools,
  ...payeeWriteTools,
  ...categoryWriteTools,
  ...automationWriteTools,
  ...reportWriteTools,
];
