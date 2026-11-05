/* oxlint-disable typescript/no-explicit-any -- tool results are untyped JSON; the tests assert their shape */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as api from '@actual-app/api';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import type { McpConfig } from './config';
import { buildTools, createServer } from './server';
import { writeTools } from './tools/write';

// Runs the real tools against a real (local, serverless) budget file.

const TEMPLATE = path.resolve(
  __dirname,
  '../../loot-core/src/mocks/files/default-budget-template',
);

const config: McpConfig = {
  serverUrl: 'http://unused',
  syncId: 'unused',
  dataDir: '',
  allowWrites: false,
  refreshAfterSeconds: 60,
  sessionToken: 'x',
};
const connection = {
  ensureFresh: async () => undefined,
  refresh: async () => undefined,
};
const ctx = { config, ...connection };

let dataDir: string;
const ids = {} as Record<string, string>;

function tool(name: string, options = { writes: false }) {
  const found = buildTools({
    config: { ...config, allowWrites: options.writes },
    connection,
  }).find(t => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return (args: Record<string, unknown> = {}) =>
    found.handler(args as never, ctx) as Promise<any>;
}

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'actual-mcp-'));
  const budget = path.join(dataDir, 'test-budget');
  await fs.mkdir(budget);
  for (const file of ['db.sqlite', 'metadata.json']) {
    await fs.copyFile(path.join(TEMPLATE, file), path.join(budget, file));
  }
  await api.init({ dataDir });
  await api.loadBudget('test-budget');

  const groups = await api.getCategoryGroups();
  const categories = groups.flatMap(g => g.categories ?? []);
  const named = (name: string) => categories.find(c => c.name === name)!;
  ids.food = named('Food').id;
  ids.general = named('General').id;
  ids.salary = categories.find(c => c.is_income)!.id;

  ids.checking = await api.createAccount({ name: 'Checking' }, 500000);
  ids.savings = await api.createAccount({ name: 'Savings' }, 0);
  ids.broker = await api.createAccount(
    { name: 'Broker', offbudget: true },
    1000000,
  );

  const monthly = [
    '2026-06-05',
    '2026-07-05',
    '2026-08-05',
    '2026-09-05',
    '2026-10-05',
  ];
  await api.addTransactions(ids.checking, [
    ...monthly.map(date => ({
      date,
      amount: -3990,
      payee_name: 'Netflix',
      category: ids.general,
    })),
    ...['2026-09-02', '2026-10-02'].map(date => ({
      date,
      amount: -12000,
      payee_name: 'Mercado',
      category: ids.food,
    })),
    { date: '2026-10-09', amount: -4500, payee_name: 'Padaria Doce' },
    { date: '2026-10-10', amount: -4500, payee_name: 'Padaria Doce' },
    {
      date: '2026-10-15',
      amount: 400000,
      payee_name: 'Employer',
      category: ids.salary,
    },
    // a split: 60 food + 40 general
    {
      date: '2026-10-20',
      amount: -10000,
      payee_name: 'Hipermercado',
      subtransactions: [
        { amount: -6000, category: ids.food },
        { amount: -4000, category: ids.general },
      ],
    },
  ]);
  await api.addTransactions(ids.broker, [
    { date: '2026-10-01', amount: 50000, payee_name: 'Dividends' },
  ]);
  // A transfer: Checking -> Savings
  const savingsPayee = (await api.getPayees()).find(
    p => p.transfer_acct === ids.savings,
  )!;
  await api.addTransactions(ids.checking, [
    { date: '2026-10-25', amount: -30000, payee: savingsPayee.id },
  ]);
});

afterAll(async () => {
  await api.shutdown();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('read tools', () => {
  it('get_overview summarizes the budget', async () => {
    const overview = await tool('get_overview')();
    expect(overview.accounts.open).toBe(4); // template account + 3
    expect(overview.transactions.total).toBeGreaterThan(10);
    expect(overview.transactions.uncategorized).toBeGreaterThanOrEqual(2);
    expect(overview.budget_type).toBe('envelope');
  });

  it('list_accounts reports balances in decimals and flags off-budget accounts', async () => {
    const accounts = await tool('list_accounts')();
    const checking = accounts.find((a: any) => a.id === ids.checking);
    const broker = accounts.find((a: any) => a.id === ids.broker);
    // 5000 start - 5*39.90 - 2*120 - 90 + 4000 - 100 - 300 transfer
    expect(checking.balance).toBe(5000 - 199.5 - 240 - 90 + 4000 - 100 - 300);
    expect(broker).toMatchObject({ off_budget: true, balance: 10500 });
  });

  it('list_categories includes ids and the new icon fields', async () => {
    const groups = await tool('list_categories')();
    const food = groups
      .flatMap((g: any) => g.categories)
      .find((c: any) => c.name === 'Food');
    expect(food.id).toBe(ids.food);
  });

  it('search_transactions filters, orders newest first and counts matches', async () => {
    const result = await tool('search_transactions')({
      text: 'netflix',
      limit: 3,
    });
    expect(result.total_matches).toBe(5);
    expect(result.returned).toBe(3);
    expect(result.transactions[0]).toMatchObject({
      date: '2026-10-05',
      amount: -39.9,
      payee: 'Netflix',
    });
  });

  it('search_transactions hides transfers by default and can include them', async () => {
    const without = await tool('search_transactions')({
      start_date: '2026-10-25',
      end_date: '2026-10-25',
    });
    expect(without.transactions).toHaveLength(0);
    const withTransfers = await tool('search_transactions')({
      start_date: '2026-10-25',
      end_date: '2026-10-25',
      include_transfers: true,
    });
    expect(withTransfers.transactions.length).toBeGreaterThan(0);
  });

  it('search_transactions finds uncategorized rows', async () => {
    const result = await tool('search_transactions')({
      uncategorized: true,
      start_date: '2026-10-01',
    });
    expect(result.transactions.map((t: any) => t.payee)).toEqual([
      'Padaria Doce',
      'Padaria Doce',
    ]);
  });

  it('run_query runs read-only AQL', async () => {
    const result = await tool('run_query')({
      table: 'transactions',
      filter: { 'payee.name': 'Netflix' },
      group_by: ['payee.name'],
      select: ['payee.name', { total: { $sum: '$amount' } }],
    });
    expect(result.rows).toEqual([{ 'payee.name': 'Netflix', total: -19950 }]);
  });

  it('get_budget_month returns decimals', async () => {
    const month = await tool('get_budget_month')({ month: '2026-10' });
    expect(month.groups.length).toBeGreaterThan(0);
    expect(typeof month.to_budget).toBe('number');
  });
});

describe('analysis tools on real data', () => {
  it('spending_by counts split children once and excludes transfers and off-budget', async () => {
    const result = await tool('spending_by')({
      start_date: '2026-10-01',
      end_date: '2026-10-31',
    });
    const byName = Object.fromEntries(
      result.rows.map((r: any) => [r.name, r.total]),
    );
    // Food: 120 + 60 (split child) ; General: 39.90 + 40 (split child); Uncategorized: 90
    expect(byName.Food).toBe(180);
    expect(byName.General).toBe(79.9);
    expect(byName.Uncategorized).toBe(90);
    expect(result.total).toBe(349.9);
  });

  it('income_vs_expense matches the same data', async () => {
    const result = await tool('income_vs_expense')({
      start_month: '2026-10',
      end_month: '2026-10',
    });
    expect(result.months[0]).toMatchObject({ income: 4000, expenses: 349.9 });
  });

  it('uncategorized_summary groups by payee', async () => {
    const result = await tool('uncategorized_summary')();
    expect(result.top_payees[0]).toMatchObject({
      payee: 'Padaria Doce',
      count: 2,
      total: 90,
    });
  });

  it('find_recurring detects the Netflix subscription', async () => {
    const result = await tool('find_recurring')({ months: 12 });
    const netflix = result.items.find((i: any) => i.payee === 'Netflix');
    expect(netflix).toMatchObject({
      cadence: 'monthly',
      typical_amount: 39.9,
      occurrences: 5,
    });
  });

  it('find_duplicates spots the repeated bakery charge', async () => {
    const result = await tool('find_duplicates')({
      start_date: '2026-10-01',
      end_date: '2026-10-31',
    });
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0].first.payee).toBe('Padaria Doce');
  });

  it('payee_category_history reflects past categorization', async () => {
    const [history] = await tool('payee_category_history')({
      payees: ['Mercado'],
    });
    expect(history.categories[0]).toMatchObject({ category: 'Food', count: 2 });
  });

  it('net_worth_over_time includes off-budget accounts', async () => {
    const result = await tool('net_worth_over_time')({ months: 3 });
    expect(result.series.at(-1).off_budget).toBeGreaterThanOrEqual(10500);
  });

  it('budget_health returns severity-ordered findings', async () => {
    const result = await tool('budget_health')({ month: '2026-10' });
    expect(Array.isArray(result.findings)).toBe(true);
    expect(result.findings.some((f: any) => f.kind === 'uncategorized')).toBe(
      true,
    );
  });
});

describe('proposal tools', () => {
  it('propose_categorization validates ids and changes nothing', async () => {
    const [row] = (await tool('search_transactions')({ uncategorized: true }))
      .transactions;
    const result = await tool('propose_categorization')({
      items: [
        {
          transaction_id: row.id,
          category_id: ids.food,
          confidence: 'high',
          reason: 'bakery',
        },
        {
          transaction_id: 'nope',
          category_id: ids.food,
          confidence: 'low',
          reason: 'x',
        },
        {
          transaction_id: row.id,
          category_id: 'bad-category',
          confidence: 'low',
          reason: 'x',
        },
      ],
    });
    expect(result.status).toBe('pending_user_approval');
    expect(result.accepted).toBe(1);
    expect(result.rejected).toHaveLength(2);
    const after = await tool('search_transactions')({
      text: 'Padaria',
      uncategorized: true,
    });
    expect(after.total_matches).toBe(2); // still uncategorized
  });

  it('propose_icons rejects unknown Tabler icons, bank logos on categories and bad ids', async () => {
    const result = await tool('propose_icons')({
      items: [
        {
          kind: 'category',
          id: ids.food,
          icon: 'tabler:shopping-cart',
          color: '#22c55e',
        },
        {
          kind: 'category',
          id: ids.food,
          icon: 'tabler:definitely-not-an-icon',
          color: '#22c55e',
        },
        {
          kind: 'category',
          id: ids.food,
          icon: 'bank:nubank',
          color: '#820ad1',
        },
        {
          kind: 'account',
          id: ids.checking,
          icon: 'bank:nubank',
          color: '#820ad1',
        },
        {
          kind: 'account',
          id: 'missing',
          icon: 'tabler:wallet',
          color: '#3b82f6',
        },
      ],
    });
    expect(result.accepted).toBe(2);
    expect(result.rejected).toHaveLength(3);
  });

  it('search_icons finds Tabler icons', async () => {
    const result = await tool('search_icons')({
      query: 'shopping cart',
      limit: 5,
    });
    expect(result.icons).toContain('tabler:shopping-cart');
  });

  it('propose_rule rejects unknown categories', async () => {
    await expect(
      tool('propose_rule')({
        name: 'x',
        conditions: [{ field: 'payee', op: 'contains', value: 'uber' }],
        actions: [{ field: 'category', op: 'set', value: 'bad' }],
      }),
    ).rejects.toThrow(/Unknown category/);
  });
});

describe('write tools', () => {
  it('are not available unless writes are enabled', () => {
    const readOnly = buildTools({ config, connection }).map(t => t.name);
    // buildTools lists them; registration is what gates them (see protocol test)
    expect(readOnly).toContain('update_transactions');
  });

  it('update_transactions applies a category change when enabled', async () => {
    const [row] = (await tool('search_transactions')({ uncategorized: true }))
      .transactions;
    await tool('update_transactions', { writes: true })({
      updates: [{ id: row.id, category_id: ids.food }],
    });
    const after = await tool('search_transactions')({
      text: 'Padaria',
      uncategorized: true,
    });
    expect(after.total_matches).toBe(1);
  });

  it('set_icon stores an icon that the API returns', async () => {
    await tool('set_icon', { writes: true })({
      kind: 'category',
      id: ids.food,
      icon: 'tabler:shopping-cart',
      color: '#22c55e',
    });
    const food = (await api.getCategories()).find(c => c.id === ids.food)!;
    expect(food).toMatchObject({
      icon: 'tabler:shopping-cart',
      icon_color: '#22c55e',
    });
  });
});

describe('extended write tools', () => {
  const w = (name: string) => tool(name, { writes: true });

  it('manage accounts, groups and reconciliation', async () => {
    const group = await w('create_account_group')({ name: 'Cash' });
    const { id } = await w('create_account')({
      name: 'Wallet',
      initial_balance: 50,
      account_group_id: group.id,
    });
    let wallet = (await api.getAccounts()).find(a => a.id === id)!;
    expect(wallet).toMatchObject({
      name: 'Wallet',
      account_group_id: group.id,
    });

    await w('update_account')({ id, name: 'Pocket', offbudget: true });
    wallet = (await api.getAccounts()).find(a => a.id === id)!;
    expect(wallet).toMatchObject({ name: 'Pocket', offbudget: true });

    const adjust = await w('reconcile_account')({ id, balance: 42.5 });
    expect(adjust).toEqual({ adjusted: true, adjustment: -7.5 });
    expect(await api.getAccountBalance(id)).toBe(4250);
    expect(await w('reconcile_account')({ id, balance: 42.5 })).toMatchObject({
      adjusted: false,
    });

    await w('move_account')({ id, before_id: ids.checking });
    await w('update_account_group')({ id: group.id, name: 'Cash & coins' });
    expect((await api.getAccountGroups()).map(g => g.name)).toContain(
      'Cash & coins',
    );

    // a non-zero balance needs somewhere to go
    await expect(w('close_account')({ id })).rejects.toThrow();
    await w('close_account')({ id, transfer_account_id: ids.savings });
    expect((await api.getAccounts()).find(a => a.id === id)!.closed).toBe(true);
    await w('reopen_account')({ id });
    expect((await api.getAccounts()).find(a => a.id === id)!.closed).toBe(
      false,
    );

    await w('delete_account')({ id });
    expect((await api.getAccounts()).some(a => a.id === id)).toBe(false);
    await w('delete_account_group')({ id: group.id });
  });

  it('creates, splits, imports and deletes transactions', async () => {
    await w('create_transactions')({
      account_id: ids.checking,
      transactions: [
        { date: '2026-11-01', amount: -20, payee_name: 'Farmacia' },
        {
          date: '2026-11-02',
          amount: -30,
          payee_name: 'Mercadinho',
          splits: [
            { amount: -10, category_id: ids.food },
            { amount: -20, category_id: ids.general },
          ],
        },
      ],
    });
    const found = await tool('search_transactions')({ text: 'Farmacia' });
    expect(found.transactions[0]).toMatchObject({ amount: -20 });
    const farmaciaId = found.transactions[0].id;

    await expect(
      w('create_transactions')({
        account_id: ids.checking,
        transactions: [
          {
            date: '2026-11-03',
            amount: -30,
            splits: [{ amount: -10 }, { amount: -10 }],
          },
        ],
      }),
    ).rejects.toThrow(/add up/);

    await expect(
      w('split_transaction')({
        id: farmaciaId,
        splits: [{ amount: -5 }, { amount: -5 }],
      }),
    ).rejects.toThrow(/add up/);
    await w('split_transaction')({
      id: farmaciaId,
      splits: [
        { amount: -5, category_id: ids.food },
        { amount: -15, category_id: ids.general },
      ],
    });
    const { data: children } = (await api.aqlQuery(
      api
        .q('transactions')
        .filter({ parent_id: farmaciaId })
        .select(['amount', 'category']),
    )) as { data: any[] };
    expect(children.map((c: any) => c.amount).sort()).toEqual([-1500, -500]);

    const preview = await w('import_transactions')({
      account_id: ids.checking,
      dry_run: true,
      transactions: [
        {
          date: '2026-11-04',
          amount: -9.99,
          payee_name: 'Spotify',
          imported_id: 'sp-1',
        },
      ],
    });
    expect(preview).toMatchObject({ dry_run: true, added: 1 });
    expect(
      (await tool('search_transactions')({ text: 'Spotify' })).total_matches,
    ).toBe(0);
    await w('import_transactions')({
      account_id: ids.checking,
      transactions: [
        {
          date: '2026-11-04',
          amount: -9.99,
          payee_name: 'Spotify',
          imported_id: 'sp-1',
        },
      ],
    });
    const again = await w('import_transactions')({
      account_id: ids.checking,
      transactions: [
        {
          date: '2026-11-04',
          amount: -9.99,
          payee_name: 'Spotify',
          imported_id: 'sp-1',
        },
      ],
    });
    expect(again.added).toBe(0);
    const spotify = await tool('search_transactions')({ text: 'Spotify' });
    expect(spotify.total_matches).toBe(1);

    await w('delete_transactions')({ ids: [spotify.transactions[0].id] });
    expect(
      (await tool('search_transactions')({ text: 'Spotify' })).total_matches,
    ).toBe(0);
  });

  it('create_transfer links both sides', async () => {
    await w('create_transfer')({
      from_account_id: ids.checking,
      to_account_id: ids.savings,
      amount: 25,
      date: '2026-11-05',
    });
    const { data } = (await api.aqlQuery(
      api
        .q('transactions')
        .filter({
          date: '2026-11-05',
          $or: [{ amount: -2500 }, { amount: 2500 }],
        })
        .select(['account', 'amount', 'transfer_id']),
    )) as { data: any[] };
    expect(data).toHaveLength(2);
    expect(data.every((t: any) => t.transfer_id)).toBe(true);
    await expect(
      w('create_transfer')({
        from_account_id: ids.checking,
        to_account_id: ids.checking,
        amount: 1,
        date: '2026-11-05',
      }),
    ).rejects.toThrow(/different/);
  });

  it('update_transactions can also change date, amount and payee', async () => {
    await w('create_transactions')({
      account_id: ids.checking,
      transactions: [{ date: '2026-11-02', amount: -20, payee_name: 'Feira' }],
    });
    const [row] = (await tool('search_transactions')({ text: 'Feira' }))
      .transactions;
    const payee = await w('create_payee')({ name: 'Mercadão' });
    await w('update_transactions')({
      updates: [
        { id: row.id, date: '2026-11-06', amount: -25, payee_id: payee.id },
      ],
    });
    const after = await tool('search_transactions')({ text: 'Mercadão' });
    expect(after.transactions[0]).toMatchObject({
      date: '2026-11-06',
      amount: -25,
    });
    await w('delete_payee')({ id: payee.id });
  });

  it('manages payees, tags and notes', async () => {
    const a = await w('create_payee')({ name: 'Cafe A' });
    const b = await w('create_payee')({ name: 'Cafe B' });
    await w('update_payee')({ id: b.id, name: 'Cafe Bee' });
    await w('merge_payees')({ target_id: a.id, merge_ids: [b.id] });
    const payees = await api.getPayees();
    expect(payees.some(p => p.id === a.id)).toBe(true);
    expect(payees.some(p => p.id === b.id)).toBe(false);
    await expect(
      w('merge_payees')({ target_id: a.id, merge_ids: [a.id] }),
    ).rejects.toThrow();
    await w('delete_payee')({ id: a.id });

    const tag = await w('create_tag')({ tag: 'trip', color: '#ff0000' });
    await w('update_tag')({ id: tag.id, description: 'Travel' });
    expect((await api.getTags()).find(t => t.id === tag.id)).toMatchObject({
      tag: 'trip',
      description: 'Travel',
    });
    await w('delete_tag')({ id: tag.id });
    expect((await api.getTags()).some(t => t.id === tag.id)).toBe(false);

    await w('set_notes')({ id: `category-${ids.food}`, note: 'Goal: 400' });
    expect((await tool('get_notes')({ id: `category-${ids.food}` })).note).toBe(
      'Goal: 400',
    );
    await w('set_notes')({ id: `category-${ids.food}`, note: '' });
  });

  it('manages categories, groups and ordering', async () => {
    const group = await w('create_category_group')({ name: 'Fun' });
    const first = await w('create_category')({
      name: 'Games',
      group_id: group.id,
    });
    const second = await w('create_category')({
      name: 'Movies',
      group_id: group.id,
    });
    await w('update_category')({ id: second.id, name: 'Cinema', hidden: true });
    await w('move_category')({
      id: second.id,
      group_id: group.id,
      before_id: first.id,
    });
    const groups = await api.getCategoryGroups();
    const fun = groups.find(g => g.id === group.id)!;
    expect(fun.categories!.map(c => c.name)).toEqual(['Cinema', 'Games']);
    expect(fun.categories![0].hidden).toBe(true);

    await w('update_category_group')({ id: group.id, name: 'Leisure' });
    const other = await w('create_category_group')({ name: 'Other' });
    await w('move_category_group')({ id: other.id, before_id: group.id });
    const order = (await api.getCategoryGroups()).map(g => g.id);
    expect(order.indexOf(other.id)).toBeLessThan(order.indexOf(group.id));

    await w('delete_category')({ id: first.id });
    await w('delete_category_group')({ id: group.id });
    await w('delete_category_group')({ id: other.id });
    const remaining = (await api.getCategoryGroups()).map(g => g.id);
    expect(remaining).not.toContain(group.id);
  });

  it('moves budget money between categories and manages holds and carryover', async () => {
    const month = '2026-10';
    await w('set_budget_amount')({ month, category_id: ids.food, amount: 300 });
    await w('set_budget_amount')({
      month,
      category_id: ids.general,
      amount: 100,
    });
    await w('transfer_budget')({
      month,
      amount: 50,
      from: ids.food,
      to: ids.general,
    });
    const view = async (id: string) =>
      (await tool('get_budget_month')({ month })).groups
        .flatMap((g: any) => g.categories)
        .find((c: any) => c.id === id);
    expect((await view(ids.food)).budgeted).toBe(250);
    expect((await view(ids.general)).budgeted).toBe(150);

    await w('transfer_budget')({
      month,
      amount: 10,
      from: ids.general,
      to: 'to-budget',
    });
    expect((await view(ids.general)).budgeted).toBe(140);
    await expect(
      w('transfer_budget')({ month, amount: 1, from: ids.food, to: ids.food }),
    ).rejects.toThrow();

    await w('set_carryover')({ month, category_id: ids.food, enabled: true });
    expect((await view(ids.food)).carryover).toBe(true);

    await w('hold_budget_for_next_month')({ month, amount: 5 });
    await w('reset_budget_hold')({ month });
  });

  it('manages rules and applies them to existing transactions', async () => {
    await w('create_transactions')({
      account_id: ids.checking,
      transactions: [
        { date: '2026-11-07', amount: -12.3, payee_name: 'Uber Trip' },
      ],
    });
    const uber = (await api.getPayees()).find(p => p.name === 'Uber Trip')!;
    const rule = await w('create_rule')({
      stage: 'pre',
      conditions: [
        { field: 'payee', op: 'is', value: uber.id },
        { field: 'amount', op: 'lt', value: -10 },
      ],
      actions: [{ field: 'category', op: 'set', value: ids.general }],
    });
    // amounts are stored in cents but listed as decimals
    const listed = (await tool('list_rules')()).find(
      (r: any) => r.id === rule.id,
    );
    expect(listed.conditions[1]).toMatchObject({ field: 'amount', value: -10 });

    const dry = await w('run_rules')({
      dry_run: true,
      from: '2026-11-07',
      to: '2026-11-07',
    });
    expect(dry).toMatchObject({ dry_run: true, changed: 1 });
    const stillOpen = await tool('search_transactions')({
      text: 'Uber',
      uncategorized: true,
    });
    expect(stillOpen.total_matches).toBe(1);

    const run = await w('run_rules')({ from: '2026-11-07', to: '2026-11-07' });
    expect(run.changed).toBe(1);
    expect(
      (await tool('search_transactions')({ text: 'Uber', uncategorized: true }))
        .total_matches,
    ).toBe(0);

    await w('update_rule')({
      id: rule.id,
      actions: [{ field: 'notes', value: 'ride' }],
    });
    const updated = (await api.getRules()).find(r => r.id === rule.id)!;
    expect(updated.actions[0]).toMatchObject({ field: 'notes', value: 'ride' });
    expect(updated.conditions).toHaveLength(2);

    await w('delete_rule')({ id: rule.id });
    expect((await api.getRules()).some(r => r.id === rule.id)).toBe(false);
  });

  it('manages schedules', async () => {
    const payee = (await api.getPayees()).find(p => p.name === 'Netflix')!;
    const { id } = await w('create_schedule')({
      name: 'Netflix plan',
      date: {
        start: '2026-12-05',
        frequency: 'monthly',
        patterns: [{ value: 5, type: 'day' }],
      },
      amount: 39.9,
      amount_op: 'isapprox',
      account_id: ids.checking,
      payee_id: payee.id,
    });
    let listed = (await tool('list_schedules')()).find((s: any) => s.id === id);
    expect(listed).toMatchObject({ name: 'Netflix plan', amount: 39.9 });

    await w('update_schedule')({ id, amount: 45, name: 'Netflix 4K' });
    listed = (await tool('list_schedules')()).find((s: any) => s.id === id);
    expect(listed).toMatchObject({ name: 'Netflix 4K', amount: 45 });

    await expect(
      w('create_schedule')({
        date: '2026-12-01',
        amount: 10,
        amount_op: 'isbetween',
        account_id: ids.checking,
        payee_id: payee.id,
      }),
    ).rejects.toThrow(/amount_max/);

    await w('delete_schedule')({ id });
    expect((await tool('list_schedules')()).some((s: any) => s.id === id)).toBe(
      false,
    );
  });

  it('manages custom reports', async () => {
    const { id } = await w('create_report')({
      name: 'Food by month',
      graph_type: 'LineGraph',
      conditions: [{ field: 'category', op: 'is', value: ids.food }],
    });
    let report = (await tool('list_reports')()).find((r: any) => r.id === id);
    expect(report).toMatchObject({
      name: 'Food by month',
      graphType: 'LineGraph',
      groupBy: 'Category',
    });
    await w('update_report')({ id, name: 'Food', interval: 'Weekly' });
    report = (await tool('list_reports')()).find((r: any) => r.id === id);
    expect(report).toMatchObject({
      name: 'Food',
      interval: 'Weekly',
      graphType: 'LineGraph',
    });
    expect(report.conditions).toHaveLength(1);
    await expect(
      w('create_report')({ name: 'Food', start_date: '2026-01-01' }),
    ).rejects.toThrow();
    await w('delete_report')({ id });
    expect((await tool('list_reports')()).some((r: any) => r.id === id)).toBe(
      false,
    );
  });
});

describe('MCP protocol', () => {
  async function connectClient(options: { writes?: boolean; ask?: boolean }) {
    const server = createServer({
      config: { ...config, allowWrites: Boolean(options.writes) },
      connection,
      ask: options.ask
        ? { endpoint: 'http://localhost:1/ask', token: 't' }
        : undefined,
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientSide);
    return client;
  }

  it('lists read, analysis and proposal tools, and hides write and ask tools by default', async () => {
    const client = await connectClient({});
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'get_overview',
        'spending_by',
        'propose_categorization',
        'run_query',
      ]),
    );
    expect(names).not.toContain('update_transactions');
    expect(names).not.toContain('ask_user');
  });

  it('exposes write tools only when enabled, and ask_user only with a host endpoint', async () => {
    const client = await connectClient({ writes: true, ask: true });
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['update_transactions', 'ask_user']),
    );
  });

  it('hides every write tool unless writes are enabled', async () => {
    const readOnly = new Set(
      (await (await connectClient({})).listTools()).tools.map(t => t.name),
    );
    const enabled = new Set(
      (await (await connectClient({ writes: true })).listTools()).tools.map(
        t => t.name,
      ),
    );
    expect(writeTools.length).toBeGreaterThan(40);
    for (const t of writeTools) {
      expect(t.write, t.name).toBe(true);
      expect(readOnly.has(t.name), t.name).toBe(false);
      expect(enabled.has(t.name), t.name).toBe(true);
    }
  });

  it('applies schema defaults, e.g. a rule action without an op', async () => {
    const client = await connectClient({ writes: true });
    const result = await client.callTool({
      name: 'create_rule',
      arguments: {
        conditions: [{ field: 'notes', op: 'contains', value: 'rent' }],
        actions: [{ field: 'category', value: ids.general }],
      },
    });
    expect(result.isError).toBeFalsy();
    const { id } = JSON.parse((result.content as { text: string }[])[0].text);
    await api.deleteRule(id);
  });

  it('calls a tool over the protocol and returns text content', async () => {
    const client = await connectClient({});
    const result = await client.callTool({
      name: 'uncategorized_summary',
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as { text: string }[])[0].text;
    expect(JSON.parse(text)).toHaveProperty('count');
  });

  it('reports tool errors as isError instead of crashing', async () => {
    const client = await connectClient({});
    const result = await client.callTool({
      name: 'propose_rule',
      arguments: {
        name: 'x',
        conditions: [{ field: 'payee', op: 'contains', value: 'u' }],
        actions: [{ field: 'category', op: 'set', value: 'bad' }],
      },
    });
    expect(result.isError).toBe(true);
  });
});
