import * as api from '@actual-app/api';

import { aql } from './api';

const { q } = api;

/** A transaction reduced to the fields analysis needs. Amounts are cents. */
export type TxRow = {
  id: string;
  date: string;
  amount: number;
  account: string;
  accountName: string;
  offBudget: boolean;
  payee: string | null;
  category: string | null;
  categoryName: string | null;
  categoryGroup: string | null;
  isIncomeCategory: boolean;
  isTransfer: boolean;
  notes: string | null;
  cleared: boolean;
};

const FIELDS = [
  'id',
  'date',
  'amount',
  'account',
  'account.name',
  'account.offbudget',
  'payee.name',
  'category',
  'category.name',
  'category.group.name',
  'category.is_income',
  'payee.transfer_acct',
  'notes',
  'cleared',
];

type RawRow = Record<string, unknown>;

export function toTxRow(raw: RawRow): TxRow {
  return {
    id: String(raw.id),
    date: String(raw.date),
    amount: Number(raw.amount ?? 0),
    account: String(raw.account),
    accountName: String(raw['account.name'] ?? ''),
    offBudget: Boolean(raw['account.offbudget']),
    payee: (raw['payee.name'] as string | null) ?? null,
    category: (raw.category as string | null) ?? null,
    categoryName: (raw['category.name'] as string | null) ?? null,
    categoryGroup: (raw['category.group.name'] as string | null) ?? null,
    isIncomeCategory: Boolean(raw['category.is_income']),
    // A transfer leg that is not categorized. Transfers to off-budget accounts
    // carry a category and behave like spending, so they are not "transfers"
    // for analysis. Detected via the payee, since linking can be absent.
    isTransfer: raw['payee.transfer_acct'] != null && raw.category == null,
    notes: (raw.notes as string | null) ?? null,
    cleared: Boolean(raw.cleared),
  };
}

export type TxFilter = {
  startDate?: string;
  endDate?: string;
  accountId?: string;
  categoryId?: string;
  uncategorized?: boolean;
  /** Matches payee name or notes, case-insensitively. */
  text?: string;
  minAmount?: number;
  maxAmount?: number;
  includeTransfers?: boolean;
};

export function buildTxFilter(filter: TxFilter): Record<string, unknown>[] {
  const clauses: Record<string, unknown>[] = [];
  if (filter.startDate) clauses.push({ date: { $gte: filter.startDate } });
  if (filter.endDate) clauses.push({ date: { $lte: filter.endDate } });
  if (filter.accountId) clauses.push({ account: filter.accountId });
  if (filter.categoryId) clauses.push({ category: filter.categoryId });
  if (filter.uncategorized) {
    // Off-budget accounts cannot have categories, so they are never "uncategorized".
    clauses.push({ category: null });
    clauses.push({ 'payee.transfer_acct': null });
    clauses.push({ 'account.offbudget': false });
  }
  if (filter.minAmount !== undefined) {
    clauses.push({ amount: { $gte: filter.minAmount } });
  }
  if (filter.maxAmount !== undefined) {
    clauses.push({ amount: { $lte: filter.maxAmount } });
  }
  if (filter.text) {
    const like = `%${filter.text.replace(/[%_]/g, '')}%`;
    clauses.push({
      $or: [{ 'payee.name': { $like: like } }, { notes: { $like: like } }],
    });
  }
  if (!filter.includeTransfers && !filter.uncategorized) {
    clauses.push({
      $or: [{ 'payee.transfer_acct': null }, { category: { $ne: null } }],
    });
  }
  return clauses;
}

function applyFilters<T extends ReturnType<typeof q>>(
  query: T,
  clauses: Record<string, unknown>[],
): T {
  let result = query;
  for (const clause of clauses) {
    result = result.filter(clause) as T;
  }
  return result;
}

export async function queryTransactions(
  filter: TxFilter,
  options: { limit?: number; offset?: number; newestFirst?: boolean } = {},
): Promise<{ rows: TxRow[]; total: number }> {
  const clauses = buildTxFilter(filter);

  let query = applyFilters(q('transactions'), clauses)
    .select(FIELDS)
    .orderBy(
      options.newestFirst === false
        ? [{ date: 'asc' }, 'id']
        : [{ date: 'desc' }, 'id'],
    );
  if (options.limit !== undefined) query = query.limit(options.limit);
  if (options.offset) query = query.offset(options.offset);

  const { data } = await aql(query);
  const rows = (data as RawRow[]).map(toTxRow);

  let total = rows.length;
  if (options.limit !== undefined && rows.length >= options.limit) {
    const counted = await aql(
      applyFilters(q('transactions'), clauses).calculate({ $count: '$id' }),
    );
    total = Number(counted.data);
  }
  return { rows, total };
}

/** Every matching transaction, for analysis. */
export async function loadTransactions(filter: TxFilter): Promise<TxRow[]> {
  const { rows } = await queryTransactions(filter, { newestFirst: false });
  return rows;
}
