import {
  detectRecurring,
  findAnomalies,
  findDuplicates,
  incomeVsExpense,
  kindOf,
  netWorthSeries,
  normalizePayee,
  payeeCategoryHistory,
  spendingBy,
  summarizeUncategorized,
} from './analysis';
import type { TxRow } from './data';

let counter = 0;
function tx(
  overrides: Partial<TxRow> & { date: string; amount: number },
): TxRow {
  counter += 1;
  return {
    id: `t${counter}`,
    account: 'a1',
    accountName: 'Checking',
    offBudget: false,
    payee: null,
    category: null,
    categoryName: null,
    categoryGroup: null,
    isIncomeCategory: false,
    isTransfer: false,
    notes: null,
    cleared: true,
    ...overrides,
  };
}

const food = {
  category: 'c-food',
  categoryName: 'Food',
  categoryGroup: 'Usual',
};
const rent = {
  category: 'c-rent',
  categoryName: 'Rent',
  categoryGroup: 'Bills',
};
const salary = {
  category: 'c-inc',
  categoryName: 'Salary',
  categoryGroup: 'Income',
  isIncomeCategory: true,
};

describe('normalizePayee', () => {
  it('ignores case, punctuation and reference numbers', () => {
    expect(normalizePayee('NETFLIX.COM 48213')).toBe('netflix com');
    expect(normalizePayee('Netflix.com')).toBe('netflix com');
    expect(normalizePayee(null)).toBe('');
  });
});

describe('kindOf', () => {
  it('classifies transfers, starting balances, income and expenses', () => {
    expect(
      kindOf(tx({ date: '2026-01-01', amount: -5, isTransfer: true })),
    ).toBe('transfer');
    expect(
      kindOf(
        tx({
          date: '2026-01-01',
          amount: 100,
          categoryName: 'Starting Balances',
          isIncomeCategory: true,
        }),
      ),
    ).toBe('starting');
    expect(kindOf(tx({ date: '2026-01-01', amount: 100, ...salary }))).toBe(
      'income',
    );
    expect(kindOf(tx({ date: '2026-01-01', amount: 100 }))).toBe('income');
    expect(kindOf(tx({ date: '2026-01-01', amount: -100 }))).toBe('expense');
    expect(kindOf(tx({ date: '2026-01-01', amount: -100, ...food }))).toBe(
      'expense',
    );
  });
});

describe('spendingBy', () => {
  const rows = [
    tx({ date: '2026-10-02', amount: -3000, payee: 'Mercado', ...food }),
    tx({ date: '2026-10-09', amount: -1000, payee: 'Mercado', ...food }),
    tx({ date: '2026-10-10', amount: 500, payee: 'Mercado', ...food }), // refund
    tx({ date: '2026-10-11', amount: -6000, payee: 'Landlord', ...rent }),
    tx({ date: '2026-10-12', amount: -2000, isTransfer: true }),
    tx({ date: '2026-10-12', amount: -9999, offBudget: true, ...food }),
    tx({ date: '2026-10-15', amount: 400000, ...salary }),
  ];

  it('nets refunds and skips transfers, income and off-budget accounts', () => {
    const result = spendingBy(rows, 'category');
    // Food: 30 + 10 - 5 refund = 35; Rent: 60.
    expect(result.total).toBe(95);
    expect(result.rows.map(r => [r.name, r.total, r.share_percent])).toEqual([
      ['Rent', 60, 63.2],
      ['Food', 35, 36.8],
    ]);
  });

  it('includes off-budget accounts on request', () => {
    expect(spendingBy(rows, 'category', { includeOffBudget: true }).total).toBe(
      194.99,
    );
  });

  it('groups by month and limits to the top N', () => {
    expect(spendingBy(rows, 'month').rows).toHaveLength(1);
    expect(spendingBy(rows, 'payee', { topN: 1 }).rows).toHaveLength(1);
  });
});

describe('incomeVsExpense', () => {
  it('reports income, expenses and the savings rate per month', () => {
    const rows = [
      tx({ date: '2026-09-05', amount: 500000, ...salary }),
      tx({ date: '2026-09-06', amount: -100000, ...rent }),
      tx({ date: '2026-10-05', amount: 500000, ...salary }),
      tx({ date: '2026-10-06', amount: -250000, ...rent }),
      tx({
        date: '2026-10-07',
        amount: 123456,
        categoryName: 'Starting Balances',
        isIncomeCategory: true,
      }),
    ];
    const [sep, oct, nov] = incomeVsExpense(rows, [
      '2026-09',
      '2026-10',
      '2026-11',
    ]);
    expect(sep).toMatchObject({
      income: 5000,
      expenses: 1000,
      net: 4000,
      savings_rate_percent: 80,
    });
    expect(oct).toMatchObject({
      income: 5000,
      expenses: 2500,
      savings_rate_percent: 50,
    });
    expect(nov).toMatchObject({
      income: 0,
      expenses: 0,
      savings_rate_percent: null,
    });
  });
});

describe('detectRecurring', () => {
  const monthly = [
    '2026-06-05',
    '2026-07-05',
    '2026-08-06',
    '2026-09-05',
    '2026-10-05',
  ].map(date => tx({ date, amount: -3990, payee: 'Netflix 12345' }));

  it('finds a monthly subscription and projects the next charge', () => {
    const [item] = detectRecurring(monthly);
    expect(item).toMatchObject({
      cadence: 'monthly',
      typical_amount: 39.9,
      occurrences: 5,
      last_date: '2026-10-05',
      next_expected: '2026-11-05',
      amount_varies: false,
      direction: 'expense',
    });
    expect(item.annualized).toBe(478.8);
  });

  it('recognises weekly income', () => {
    const rows = ['2026-10-02', '2026-10-09', '2026-10-16', '2026-10-23'].map(
      date => tx({ date, amount: 20000, payee: 'Gig', ...salary }),
    );
    expect(detectRecurring(rows)[0]).toMatchObject({
      cadence: 'weekly',
      direction: 'income',
    });
  });

  it('ignores irregular spending and too few occurrences', () => {
    const irregular = [
      '2026-06-01',
      '2026-06-04',
      '2026-08-20',
      '2026-09-02',
    ].map(date => tx({ date, amount: -1500, payee: 'Cafe' }));
    expect(detectRecurring(irregular)).toEqual([]);
    expect(detectRecurring(monthly.slice(0, 2))).toEqual([]);
  });

  it('flags varying amounts such as utilities', () => {
    const rows = [
      ['2026-07-10', -8000],
      ['2026-08-10', -15000],
      ['2026-09-10', -9000],
      ['2026-10-10', -17000],
    ].map(([date, amount]) =>
      tx({ date: date as string, amount: amount as number, payee: 'Power Co' }),
    );
    expect(detectRecurring(rows)[0]).toMatchObject({
      cadence: 'monthly',
      amount_varies: true,
    });
  });
});

describe('findDuplicates', () => {
  it('pairs the same amount and payee a day apart, but not transfers or far-apart charges', () => {
    const rows = [
      tx({ date: '2026-10-05', amount: -4500, payee: 'Restaurante X' }),
      tx({ date: '2026-10-06', amount: -4500, payee: 'restaurante x' }),
      tx({ date: '2026-10-20', amount: -4500, payee: 'Restaurante X' }),
      tx({
        date: '2026-10-05',
        amount: -900,
        isTransfer: true,
        payee: 'Transfer',
      }),
      tx({
        date: '2026-10-05',
        amount: -900,
        isTransfer: true,
        payee: 'Transfer',
      }),
    ];
    const pairs = findDuplicates(rows);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].days_apart).toBe(1);
  });
});

describe('findAnomalies', () => {
  const steady = [
    '2026-04',
    '2026-05',
    '2026-06',
    '2026-07',
    '2026-08',
    '2026-09',
  ].flatMap((m, i) => [
    tx({
      date: `${m}-10`,
      amount: -(50000 + (i % 2) * 2000),
      payee: 'Mercado',
      ...food,
    }),
  ]);

  it('flags a category month far above its history', () => {
    const rows = [
      ...steady,
      tx({ date: '2026-10-10', amount: -150000, payee: 'Shop', ...food }),
    ];
    const { spikes } = findAnomalies(rows, ['2026-10']);
    expect(spikes).toHaveLength(1);
    expect(spikes[0]).toMatchObject({ category: 'Food', month: '2026-10' });
    expect(spikes[0].times_typical).toBeGreaterThan(2);
  });

  it('does not flag normal months', () => {
    const rows = [
      ...steady,
      tx({ date: '2026-10-10', amount: -51000, payee: 'Mercado', ...food }),
    ];
    expect(findAnomalies(rows, ['2026-10']).spikes).toEqual([]);
  });

  it('flags a transaction much larger than the payee norm', () => {
    const rows = [
      ...['2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01'].map(date =>
        tx({ date, amount: -4000, payee: 'Farmacia', ...food }),
      ),
      tx({ date: '2026-10-03', amount: -48000, payee: 'Farmacia', ...food }),
    ];
    const { large_transactions } = findAnomalies(rows, ['2026-10']);
    expect(large_transactions).toHaveLength(1);
    expect(large_transactions[0]).toMatchObject({
      amount: 480,
      typical_for_payee: 40,
    });
  });
});

describe('netWorthSeries', () => {
  it('accumulates balances and splits on/off budget', () => {
    const rows = [
      tx({ date: '2026-08-15', amount: 100000 }),
      tx({ date: '2026-09-15', amount: -20000 }),
      tx({ date: '2026-09-20', amount: 500000, offBudget: true }),
      tx({ date: '2026-10-15', amount: -10000 }),
    ];
    expect(netWorthSeries(rows, ['2026-08', '2026-09', '2026-10'])).toEqual([
      { month: '2026-08', net_worth: 1000, on_budget: 1000, off_budget: 0 },
      { month: '2026-09', net_worth: 5800, on_budget: 800, off_budget: 5000 },
      { month: '2026-10', net_worth: 5700, on_budget: 700, off_budget: 5000 },
    ]);
  });
});

describe('summarizeUncategorized', () => {
  it('counts pending rows by payee, ignoring transfers and categorized rows', () => {
    const rows = [
      tx({ date: '2026-10-01', amount: -1000, payee: 'Padaria' }),
      tx({ date: '2026-10-03', amount: -2000, payee: 'Padaria' }),
      tx({ date: '2026-09-28', amount: -500, payee: 'Uber' }),
      tx({ date: '2026-10-04', amount: -700, isTransfer: true }),
      tx({ date: '2026-10-05', amount: -900, ...food }),
    ];
    const summary = summarizeUncategorized(rows);
    expect(summary).toMatchObject({
      count: 3,
      total_spent: 35,
      oldest: '2026-09-28',
    });
    expect(summary.top_payees[0]).toMatchObject({
      payee: 'Padaria',
      count: 2,
      total: 30,
    });
  });
});

describe('payeeCategoryHistory', () => {
  it('shows how a payee was categorized before', () => {
    const rows = [
      tx({ date: '2026-09-01', amount: -1000, payee: 'Padaria Doce', ...food }),
      tx({
        date: '2026-09-08',
        amount: -1000,
        payee: 'PADARIA DOCE 9921',
        ...food,
      }),
      tx({ date: '2026-09-15', amount: -1000, payee: 'Padaria Doce', ...rent }),
      tx({ date: '2026-09-16', amount: -1000, payee: 'Padaria Doce' }),
    ];
    const [history] = payeeCategoryHistory(rows, ['Padaria Doce', 'Unknown']);
    expect(history.transactions).toBe(3);
    expect(history.categories[0]).toMatchObject({
      category: 'Food',
      count: 2,
      share_percent: 66.7,
    });
    expect(payeeCategoryHistory(rows, ['Unknown'])[0].categories).toEqual([]);
  });
});
