import { send } from '@actual-app/core/platform/client/connection';
import type { NewRuleEntity } from '@actual-app/core/types/models';

import type { ToolPart } from './types';

// The assistant never changes the budget itself. It calls `propose_*` tools; the
// chat shows each as a card, and approving applies it here, through the same
// handlers the rest of the app uses, so every change is synced and can be
// undone with the usual shortcut.

export type Confidence = 'high' | 'medium' | 'low';

export type CategorizationItem = {
  transaction_id: string;
  category_id: string;
  confidence: Confidence;
  reason: string;
};

export type CategorizationProposal = {
  kind: 'categorization';
  title?: string;
  items: CategorizationItem[];
};

export type RuleProposal = {
  kind: 'rule';
  name: string;
  stage?: 'pre' | 'post';
  conditions_op?: 'and' | 'or';
  conditions: { field: string; op: string; value: unknown }[];
  actions: { field: string; op: 'set'; value: unknown }[];
  reason?: string;
};

export type BudgetChange = {
  category_id: string;
  budgeted: number;
  reason: string;
};

export type BudgetProposal = {
  kind: 'budget';
  month: string;
  changes: BudgetChange[];
};

export type IconItem = {
  kind: 'category' | 'account';
  id: string;
  icon: string;
  color: string;
};

export type IconsProposal = { kind: 'icons'; items: IconItem[] };

export type Proposal =
  | CategorizationProposal
  | RuleProposal
  | BudgetProposal
  | IconsProposal;

export function isProposalTool(name: string): boolean {
  return name.startsWith('propose_');
}

/** Ids the tool refused (unknown ids, no-op changes); they are not shown. */
export function rejectedIds(tool: ToolPart): Set<string> {
  try {
    const parsed = JSON.parse(tool.result?.text ?? '{}') as {
      rejected?: { id: string }[];
    };
    return new Set((parsed.rejected ?? []).map(r => r.id));
  } catch {
    return new Set();
  }
}

export function parseProposal(tool: ToolPart): Proposal | null {
  if (!tool.result || tool.result.isError) return null;
  const input = (tool.input ?? {}) as Record<string, unknown>;
  switch (tool.name) {
    case 'propose_categorization': {
      const rejected = rejectedIds(tool);
      const items = ((input.items ?? []) as CategorizationItem[]).filter(
        item => !rejected.has(item.transaction_id),
      );
      return items.length
        ? {
            kind: 'categorization',
            title: input.title as string | undefined,
            items,
          }
        : null;
    }
    case 'propose_rule':
      return { kind: 'rule', ...(input as Omit<RuleProposal, 'kind'>) };
    case 'propose_budget_change':
      return { kind: 'budget', ...(input as Omit<BudgetProposal, 'kind'>) };
    case 'propose_icons': {
      const rejected = rejectedIds(tool);
      const items = ((input.items ?? []) as IconItem[]).filter(
        item => !rejected.has(item.id),
      );
      return items.length ? { kind: 'icons', items } : null;
    }
    default:
      return null;
  }
}

// ----------------------------------------------------------------- applying

export async function applyCategorization(items: CategorizationItem[]) {
  await send('transactions-batch-update', {
    updated: items.map(item => ({
      id: item.transaction_id,
      category: item.category_id,
    })),
  });
}

export async function applyRule(proposal: RuleProposal) {
  // Shape matches the app's own rule editor; loot-core validates it and
  // returns { error } for anything malformed.
  const rule = {
    stage: proposal.stage ?? null,
    conditionsOp: proposal.conditions_op ?? 'and',
    conditions: proposal.conditions,
    actions: proposal.actions,
  } as unknown as NewRuleEntity;
  const result = await send('rule-add', rule);
  if (result && 'error' in result && result.error) {
    throw new Error('The rule is not valid and could not be created.');
  }
}

export async function applyBudgetChanges(
  month: string,
  changes: BudgetChange[],
) {
  for (const change of changes) {
    await send('budget/budget-amount', {
      category: change.category_id,
      month,
      amount: Math.round(change.budgeted * 100),
    });
  }
}

export async function applyIcons(items: IconItem[]) {
  const categories = items.filter(item => item.kind === 'category');
  if (categories.length) {
    const { list } = await send('get-categories');
    for (const item of categories) {
      const category = list.find(c => c.id === item.id);
      if (category) {
        await send('category-update', {
          ...category,
          icon: item.icon,
          icon_color: item.color,
        });
      }
    }
  }
  for (const item of items.filter(i => i.kind === 'account')) {
    await send('account-update', {
      id: item.id,
      icon: item.icon,
      icon_color: item.color,
    });
  }
}
