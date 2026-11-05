import * as api from '@actual-app/api';
import { z } from 'zod';

import { aql } from '#api';
import { fromMoney, toMoney } from '#format';
import { defineTool } from '#registry';

const { q } = api;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const split = z.object({
  amount: z.number().describe('Decimal; splits must add up to the total'),
  category_id: z.string().nullable().optional(),
  notes: z.string().optional(),
});

function toSplits(splits: z.infer<typeof split>[]) {
  return splits.map(s => ({
    amount: fromMoney(s.amount),
    category: s.category_id ?? undefined,
    notes: s.notes,
  }));
}

export const transactionWriteTools = [
  defineTool({
    name: 'create_transactions',
    write: true,
    description:
      'Add transactions to one account (up to 100). Amounts are decimals: negative = money out. Use payee_id for an existing payee or payee_name (created if new); a payee that is another account makes a transfer and the matching transaction is created in that account. Use splits to divide one transaction across categories.',
    shape: {
      account_id: z.string(),
      transactions: z
        .array(
          z.object({
            date: day,
            amount: z.number(),
            payee_id: z.string().optional(),
            payee_name: z.string().optional(),
            category_id: z.string().nullable().optional(),
            notes: z.string().optional(),
            cleared: z.boolean().optional(),
            splits: z.array(split).min(2).optional(),
          }),
        )
        .min(1)
        .max(100),
    },
    handler: async ({ account_id, transactions }, ctx) => {
      for (const t of transactions) {
        if (!t.splits) continue;
        const sum = t.splits.reduce((s, x) => s + fromMoney(x.amount), 0);
        if (sum !== fromMoney(t.amount)) {
          throw new Error(
            `Splits for the ${t.date} transaction add up to ${toMoney(sum)}, not ${t.amount}.`,
          );
        }
      }
      await api.addTransactions(
        account_id,
        transactions.map(t => ({
          date: t.date,
          amount: fromMoney(t.amount),
          payee: t.payee_id,
          payee_name: t.payee_id ? undefined : t.payee_name,
          category: t.category_id ?? undefined,
          notes: t.notes,
          cleared: t.cleared,
          subtransactions: t.splits ? toSplits(t.splits) : undefined,
        })),
        { runTransfers: true },
      );
      await ctx.refresh();
      return { created: transactions.length };
    },
  }),

  defineTool({
    name: 'create_transfer',
    write: true,
    description:
      'Move money between two of the user\'s accounts. Creates both sides linked as a transfer. "amount" is a positive decimal.',
    shape: {
      from_account_id: z.string(),
      to_account_id: z.string(),
      amount: z.number().positive(),
      date: day,
      notes: z.string().optional(),
      cleared: z.boolean().optional(),
    },
    handler: async (
      { from_account_id, to_account_id, amount, date, notes, cleared },
      ctx,
    ) => {
      if (from_account_id === to_account_id) {
        throw new Error('A transfer needs two different accounts.');
      }
      const payee = (await api.getPayees()).find(
        p => p.transfer_acct === to_account_id,
      );
      if (!payee) throw new Error(`No account ${to_account_id}.`);
      await api.addTransactions(
        from_account_id,
        [{ date, amount: -fromMoney(amount), payee: payee.id, notes, cleared }],
        { runTransfers: true },
      );
      await ctx.refresh();
      return { ok: true };
    },
  }),

  defineTool({
    name: 'import_transactions',
    write: true,
    description:
      'Import transactions into an account like a bank import: rules run, categories are learned and transactions already present (same imported_id, or matching amount/date/payee) are skipped or updated rather than duplicated. Prefer this over create_transactions for statement data. Use dry_run to preview.',
    shape: {
      account_id: z.string(),
      transactions: z
        .array(
          z.object({
            date: day,
            amount: z.number(),
            payee_name: z.string().optional(),
            imported_id: z.string().optional(),
            notes: z.string().optional(),
            cleared: z.boolean().optional(),
          }),
        )
        .min(1)
        .max(500),
      dry_run: z.boolean().optional(),
    },
    handler: async ({ account_id, transactions, dry_run }, ctx) => {
      const result = (await api.importTransactions(
        account_id,
        transactions.map(t => ({
          account: account_id,
          date: t.date,
          amount: fromMoney(t.amount),
          payee_name: t.payee_name,
          imported_id: t.imported_id,
          notes: t.notes,
          cleared: t.cleared,
        })),
        { defaultCleared: true, dryRun: dry_run ?? false },
      )) as { added: unknown[]; updated: unknown[]; errors?: unknown[] };
      if (!dry_run) await ctx.refresh();
      return {
        dry_run: dry_run ?? false,
        added: result.added?.length ?? 0,
        updated: result.updated?.length ?? 0,
        errors: result.errors ?? [],
      };
    },
  }),

  defineTool({
    name: 'split_transaction',
    write: true,
    description:
      'Split an existing transaction across categories. Splits (decimal amounts, same sign as the transaction) must add up to its total. To undo a split, delete it and re-create it.',
    shape: { id: z.string(), splits: z.array(split).min(2).max(20) },
    handler: async ({ id, splits }, ctx) => {
      const { data } = await aql<{ amount: number; is_child: boolean }[]>(
        q('transactions').filter({ id }).select(['amount', 'is_child']),
      );
      const [row] = data;
      if (!row) throw new Error(`No transaction ${id}.`);
      if (row.is_child) throw new Error('That transaction is already a split.');
      const sum = splits.reduce((s, x) => s + fromMoney(x.amount), 0);
      if (sum !== row.amount) {
        throw new Error(
          `Splits add up to ${toMoney(sum)} but the transaction is ${toMoney(row.amount)}.`,
        );
      }
      await api.updateTransaction(id, {
        subtransactions: toSplits(splits),
      } as never);
      await ctx.refresh();
      return { ok: true, parts: splits.length };
    },
  }),

  defineTool({
    name: 'delete_transactions',
    write: true,
    description:
      'Permanently delete transactions by id (up to 100). Deleting one side of a transfer also removes the other side.',
    shape: { ids: z.array(z.string()).min(1).max(100) },
    handler: async ({ ids }, ctx) => {
      await api.batchBudgetUpdates(async () => {
        for (const id of ids) await api.deleteTransaction(id);
      });
      await ctx.refresh();
      return { deleted: ids.length };
    },
  }),

  defineTool({
    name: 'merge_transactions',
    write: true,
    description:
      'Merge two transactions that are the same purchase (e.g. a manual entry and its bank import) into one.',
    shape: { ids: z.tuple([z.string(), z.string()]) },
    handler: async ({ ids }, ctx) => {
      await api.mergeTransactions(ids);
      await ctx.refresh();
      return { ok: true };
    },
  }),
];
