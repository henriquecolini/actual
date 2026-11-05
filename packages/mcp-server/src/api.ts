import * as api from '@actual-app/api';

// The public API types AQL results and budget months as `unknown`. These thin
// wrappers give the rest of the package real types in one place.

type Query = ReturnType<typeof api.q>;

export async function aql<T = unknown>(query: Query): Promise<{ data: T }> {
  return (await api.aqlQuery(query)) as { data: T };
}

export type BudgetCategory = {
  id: string;
  name: string;
  is_income: boolean;
  hidden: boolean;
  group_id: string;
  budgeted: number;
  spent: number;
  balance: number;
  carryover: boolean;
};

export type BudgetGroup = {
  id: string;
  name: string;
  is_income: boolean;
  hidden: boolean;
  budgeted: number;
  spent: number;
  balance: number;
  categories: BudgetCategory[];
};

export type BudgetMonth = {
  month: string;
  incomeAvailable: number;
  lastMonthOverspent: number;
  forNextMonth: number;
  totalBudgeted: number;
  toBudget: number;
  fromLastMonth: number;
  totalIncome: number;
  totalSpent: number;
  totalBalance: number;
  categoryGroups: BudgetGroup[];
};

export async function budgetMonth(month: string): Promise<BudgetMonth> {
  return (await api.getBudgetMonth(month)) as unknown as BudgetMonth;
}
