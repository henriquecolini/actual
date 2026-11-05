/* oxlint-disable typescript/no-explicit-any -- tool results are untyped JSON; the tests assert their shape */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as api from '@actual-app/api';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import type { McpConfig } from './config';
import { buildTools, createServer } from './server';

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
