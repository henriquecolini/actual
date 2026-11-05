import * as api from '@actual-app/api';
import { z } from 'zod';

import { aql } from '#api';
import { defineTool } from '#registry';

const { q } = api;

// Proposal tools change NOTHING. The chat UI renders each call as a card the
// user can approve; approved changes are applied by the app itself (so they are
// undoable and sync like any other edit). Tools only validate ids and echo.

const PENDING =
  'Shown to the user for approval in the chat. Nothing has been changed yet; do not say it has been applied. Wait for the user to respond.';

type Problem = { id: string; problem: string };

async function categoryIds(): Promise<Map<string, string>> {
  const categories = await api.getCategories();
  return new Map(categories.map(c => [c.id, c.name]));
}

async function accountIds(): Promise<Map<string, string>> {
  const accounts = await api.getAccounts();
  return new Map(accounts.map(a => [a.id, a.name]));
}

let tablerNames: Promise<Set<string>> | null = null;
function loadTablerNames(): Promise<Set<string>> {
  tablerNames ??= import('@iconify-json/tabler').then(
    ({ icons }) =>
      new Set([
        ...Object.keys(icons.icons),
        ...Object.keys(icons.aliases ?? {}),
      ]),
  );
  return tablerNames;
}

const confidence = z.enum(['high', 'medium', 'low']);

export const proposalTools = [
  defineTool({
    name: 'propose_categorization',
    description:
      'Propose categories for transactions. The user reviews each suggestion and applies the ones they accept. Base suggestions on evidence (payee_category_history, similar transactions, rules) and give a short reason per item. Send up to 200 items per call; call again for more.',
    shape: {
      title: z
        .string()
        .optional()
        .describe('Short heading for the review card'),
      items: z
        .array(
          z.object({
            transaction_id: z.string(),
            category_id: z.string(),
            confidence,
            reason: z.string().describe('One short sentence of evidence'),
          }),
        )
        .min(1)
        .max(200),
    },
    handler: async ({ items }) => {
      const categories = await categoryIds();
      const ids = [...new Set(items.map(i => i.transaction_id))];
      const { data } = await aql(
        q('transactions')
          .filter({ id: { $oneof: ids } })
          .select(['id', 'category']),
      );
      const existing = new Map(
        (data as { id: string; category: string | null }[]).map(r => [
          r.id,
          r.category,
        ]),
      );

      const rejected: Problem[] = [];
      let accepted = 0;
      for (const item of items) {
        if (!existing.has(item.transaction_id)) {
          rejected.push({
            id: item.transaction_id,
            problem: 'unknown transaction id',
          });
        } else if (!categories.has(item.category_id)) {
          rejected.push({
            id: item.transaction_id,
            problem: `unknown category id ${item.category_id}`,
          });
        } else if (existing.get(item.transaction_id) === item.category_id) {
          rejected.push({
            id: item.transaction_id,
            problem: 'already has this category',
          });
        } else {
          accepted += 1;
        }
      }
      return {
        status: 'pending_user_approval',
        accepted,
        rejected,
        note: rejected.length
          ? `Invalid items were dropped from the card; fix them and propose again if needed. ${PENDING}`
          : PENDING,
      };
    },
  }),

  defineTool({
    name: 'propose_rule',
    description:
      'Propose an automation rule, e.g. "payee contains Uber → category Transport", so future transactions are handled automatically. The user reviews and creates it.',
    shape: {
      name: z.string().describe('What the rule does, in a few words'),
      stage: z.enum(['pre', 'post']).optional(),
      conditions_op: z.enum(['and', 'or']).optional(),
      conditions: z
        .array(
          z.object({
            field: z.enum([
              'payee',
              'imported_payee',
              'notes',
              'amount',
              'account',
              'category',
              'date',
            ]),
            op: z.enum([
              'is',
              'contains',
              'doesNotContain',
              'oneOf',
              'matches',
              'gt',
              'gte',
              'lt',
              'lte',
              'isapprox',
            ]),
            value: z.union([z.string(), z.number(), z.array(z.string())]),
          }),
        )
        .min(1),
      actions: z
        .array(
          z.object({
            field: z.enum(['category', 'payee', 'notes', 'cleared']),
            op: z.literal('set'),
            value: z.union([z.string(), z.boolean()]),
          }),
        )
        .min(1),
      reason: z.string().optional(),
    },
    handler: async ({ actions }) => {
      const categories = await categoryIds();
      const bad = actions.filter(
        a => a.field === 'category' && !categories.has(String(a.value)),
      );
      if (bad.length) {
        throw new Error(
          `Unknown category id in action: ${bad.map(a => a.value).join(', ')}. Use list_categories for valid ids.`,
        );
      }
      return { status: 'pending_user_approval', note: PENDING };
    },
  }),

  defineTool({
    name: 'propose_budget_change',
    description:
      'Propose new budgeted amounts for categories in one month. The user reviews the before/after and applies.',
    shape: {
      month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
      changes: z
        .array(
          z.object({
            category_id: z.string(),
            budgeted: z
              .number()
              .min(0)
              .describe('New budgeted amount as a decimal'),
            reason: z.string(),
          }),
        )
        .min(1)
        .max(60),
    },
    handler: async ({ month, changes }) => {
      const categories = await categoryIds();
      const bad = changes.filter(c => !categories.has(c.category_id));
      if (bad.length) {
        throw new Error(
          `Unknown category ids: ${bad.map(c => c.category_id).join(', ')}.`,
        );
      }
      return { status: 'pending_user_approval', month, note: PENDING };
    },
  }),

  defineTool({
    name: 'propose_icons',
    description:
      'Propose icons and colors for categories and accounts. Use search_icons to find valid Tabler icon names; icons are written "tabler:<name>". Accounts can also use a bank logo "bank:<slug>" (nubank, itau, inter, caixa, c6, bradesco, santander, btg, sicoob, safra, picpay, mercadopago, pagbank, pan, neon, next, carrefour, generic). Colors are hex like #3b82f6.',
    shape: {
      items: z
        .array(
          z.object({
            kind: z.enum(['category', 'account']),
            id: z.string(),
            icon: z.string(),
            color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
          }),
        )
        .min(1)
        .max(100),
    },
    handler: async ({ items }) => {
      const [categories, accounts, names] = await Promise.all([
        categoryIds(),
        accountIds(),
        loadTablerNames(),
      ]);
      const banks = new Set([
        'nubank',
        'itau',
        'inter',
        'caixa',
        'c6',
        'bradesco',
        'santander',
        'btg',
        'sicoob',
        'safra',
        'picpay',
        'mercadopago',
        'pagbank',
        'pan',
        'neon',
        'next',
        'carrefour',
        'generic',
      ]);
      const rejected: Problem[] = [];
      for (const item of items) {
        const known = (item.kind === 'category' ? categories : accounts).has(
          item.id,
        );
        const [set, name] = [
          item.icon.split(':')[0],
          item.icon.split(':').slice(1).join(':'),
        ];
        if (!known) {
          rejected.push({ id: item.id, problem: `unknown ${item.kind} id` });
        } else if (set === 'tabler' && !names.has(name)) {
          rejected.push({
            id: item.id,
            problem: `no Tabler icon named "${name}"; use search_icons`,
          });
        } else if (
          set === 'bank' &&
          (item.kind !== 'account' || !banks.has(name))
        ) {
          rejected.push({
            id: item.id,
            problem:
              'bank logos are only for accounts and must use a known slug',
          });
        } else if (set !== 'tabler' && set !== 'bank') {
          rejected.push({
            id: item.id,
            problem: 'icon must start with "tabler:" or "bank:"',
          });
        }
      }
      return {
        status: 'pending_user_approval',
        accepted: items.length - rejected.length,
        rejected,
        note: PENDING,
      };
    },
  }),

  defineTool({
    name: 'search_icons',
    description:
      'Search the Tabler icon set by keyword (English words such as "cart", "pizza", "bus", "heart"). Returns icon names to use as "tabler:<name>".',
    shape: {
      query: z.string(),
      limit: z.number().int().min(1).max(60).optional(),
    },
    handler: async ({ query, limit }) => {
      const names = [...(await loadTablerNames())].sort();
      const terms = query
        .toLowerCase()
        .split(/[\s-]+/)
        .filter(Boolean);
      const joined = terms.join('-');
      const rank = (name: string) =>
        name === joined
          ? 0
          : name.startsWith(joined)
            ? 1
            : terms.every(t => name.split('-').includes(t))
              ? 2
              : 3;
      const matches = names
        .filter(name => terms.every(term => name.includes(term)))
        .sort((a, b) => rank(a) - rank(b))
        .slice(0, limit ?? 20);
      return { icons: matches.map(name => `tabler:${name}`) };
    },
  }),
];
