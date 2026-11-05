import * as api from '@actual-app/api';
import { z } from 'zod';

import { internalSend } from '#api';
import { fromMoney, today, toMoney } from '#format';
import { defineTool } from '#registry';

export const accountWriteTools = [
  defineTool({
    name: 'create_account',
    write: true,
    description:
      'Create an account, optionally with an opening balance (decimal) and an account group. Off-budget accounts (investments, mortgages) do not use the envelope budget.',
    shape: {
      name: z.string().min(1),
      offbudget: z.boolean().optional(),
      initial_balance: z.number().optional(),
      account_group_id: z.string().optional(),
    },
    handler: async (
      { name, offbudget, initial_balance, account_group_id },
      ctx,
    ) => {
      const id = await api.createAccount(
        { name, offbudget: offbudget ?? false },
        fromMoney(initial_balance ?? 0),
      );
      if (account_group_id) {
        await api.updateAccount(id, { account_group_id });
      }
      await ctx.refresh();
      return { id };
    },
  }),

  defineTool({
    name: 'update_account',
    write: true,
    description:
      'Rename an account, switch it between on/off budget, or move it to another account group (null = ungrouped). For icons use set_icon; to reorder use move_account.',
    shape: {
      id: z.string(),
      name: z.string().min(1).optional(),
      offbudget: z.boolean().optional(),
      account_group_id: z.string().nullable().optional(),
    },
    handler: async ({ id, ...fields }, ctx) => {
      const changes = Object.fromEntries(
        Object.entries(fields).filter(([, v]) => v !== undefined),
      );
      if (!Object.keys(changes).length) throw new Error('Nothing to update.');
      await api.updateAccount(id, changes);
      await ctx.refresh();
      return { ok: true };
    },
  }),

  defineTool({
    name: 'close_account',
    write: true,
    description:
      'Close an account. An account with a non-zero balance needs transfer_account_id (where the balance goes); if that target is on budget and the closed one is off budget, also pass transfer_category_id.',
    shape: {
      id: z.string(),
      transfer_account_id: z.string().optional(),
      transfer_category_id: z.string().optional(),
    },
    handler: async ({ id, transfer_account_id, transfer_category_id }, ctx) => {
      await api.closeAccount(id, transfer_account_id, transfer_category_id);
      await ctx.refresh();
      return { ok: true };
    },
  }),

  defineTool({
    name: 'reopen_account',
    write: true,
    description: 'Reopen a closed account.',
    shape: { id: z.string() },
    handler: async ({ id }, ctx) => {
      await api.reopenAccount(id);
      await ctx.refresh();
      return { ok: true };
    },
  }),

  defineTool({
    name: 'delete_account',
    write: true,
    description:
      'Permanently delete an account AND all of its transactions. Prefer close_account unless the user clearly wants it gone.',
    shape: { id: z.string() },
    handler: async ({ id }, ctx) => {
      await api.deleteAccount(id);
      await ctx.refresh();
      return { ok: true };
    },
  }),

  defineTool({
    name: 'reconcile_account',
    write: true,
    description:
      'Make an account balance match a statement balance (decimal) by adding a cleared "Reconciliation Balance Adjustment" transaction for the difference. Does nothing if the balance already matches.',
    shape: {
      id: z.string(),
      balance: z.number().describe('Balance the account should have'),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe('Defaults to today'),
    },
    handler: async ({ id, balance, date }, ctx) => {
      const current = Number(await api.getAccountBalance(id));
      const difference = fromMoney(balance) - current;
      if (difference === 0) {
        return { adjusted: false, balance: toMoney(current) };
      }
      await api.addTransactions(id, [
        {
          date: date ?? today(),
          amount: difference,
          payee_name: 'Reconciliation Balance Adjustment',
          cleared: true,
          notes: 'Reconciliation balance adjustment',
        },
      ]);
      await ctx.refresh();
      return { adjusted: true, adjustment: toMoney(difference) };
    },
  }),

  defineTool({
    name: 'move_account',
    write: true,
    description:
      'Reorder an account: place it before another account (before_id), or last when before_id is null. Optionally change its account group in the same step (null = ungrouped).',
    shape: {
      id: z.string(),
      before_id: z.string().nullable(),
      account_group_id: z.string().nullable().optional(),
    },
    handler: async ({ id, before_id, account_group_id }, ctx) => {
      await internalSend('account-move', {
        id,
        targetId: before_id,
        accountGroupId: account_group_id,
      });
      await ctx.refresh();
      return { ok: true };
    },
  }),

  defineTool({
    name: 'create_account_group',
    write: true,
    description: 'Create a group for organising accounts in the sidebar.',
    shape: { name: z.string().min(1) },
    handler: async ({ name }, ctx) => {
      const id = await api.createAccountGroup({ name });
      await ctx.refresh();
      return { id };
    },
  }),

  defineTool({
    name: 'update_account_group',
    write: true,
    description: 'Rename an account group.',
    shape: { id: z.string(), name: z.string().min(1) },
    handler: async ({ id, name }, ctx) => {
      await api.updateAccountGroup(id, { name });
      await ctx.refresh();
      return { ok: true };
    },
  }),

  defineTool({
    name: 'delete_account_group',
    write: true,
    description:
      'Delete an account group. Its accounts are kept and become ungrouped.',
    shape: { id: z.string() },
    handler: async ({ id }, ctx) => {
      await api.deleteAccountGroup(id);
      await ctx.refresh();
      return { ok: true };
    },
  }),
];
