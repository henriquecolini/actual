import * as api from '@actual-app/api';
import { z } from 'zod';

import { defineTool } from '#registry';

export const payeeWriteTools = [
  defineTool({
    name: 'create_payee',
    write: true,
    description: 'Create a payee.',
    shape: { name: z.string().min(1) },
    handler: async ({ name }, ctx) => {
      const id = await api.createPayee({ name });
      await ctx.refresh();
      return { id };
    },
  }),

  defineTool({
    name: 'update_payee',
    write: true,
    description:
      'Rename a payee. Transfer payees (one per account) follow the account name and cannot be renamed here.',
    shape: { id: z.string(), name: z.string().min(1) },
    handler: async ({ id, name }, ctx) => {
      await api.updatePayee(id, { name });
      await ctx.refresh();
      return { ok: true };
    },
  }),

  defineTool({
    name: 'delete_payee',
    write: true,
    description:
      'Delete a payee. Its transactions keep their data but lose the payee.',
    shape: { id: z.string() },
    handler: async ({ id }, ctx) => {
      await api.deletePayee(id);
      await ctx.refresh();
      return { ok: true };
    },
  }),

  defineTool({
    name: 'merge_payees',
    write: true,
    description:
      'Merge duplicate payees: every transaction and rule using a payee in merge_ids is moved to target_id and the merged payees are deleted.',
    shape: {
      target_id: z.string(),
      merge_ids: z.array(z.string()).min(1).max(50),
    },
    handler: async ({ target_id, merge_ids }, ctx) => {
      if (merge_ids.includes(target_id)) {
        throw new Error('target_id cannot also be in merge_ids.');
      }
      await api.mergePayees(target_id, merge_ids);
      await ctx.refresh();
      return { merged: merge_ids.length };
    },
  }),

  defineTool({
    name: 'create_tag',
    write: true,
    description:
      'Create a tag (used as #tag in transaction notes). Color is #rrggbb.',
    shape: {
      tag: z.string().min(1),
      color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .nullable()
        .optional(),
      description: z.string().nullable().optional(),
    },
    handler: async ({ tag, color, description }, ctx) => {
      const id = await api.createTag({
        tag,
        color: color ?? null,
        description: description ?? null,
      });
      await ctx.refresh();
      return { id };
    },
  }),

  defineTool({
    name: 'update_tag',
    write: true,
    description: 'Change a tag name, color (#rrggbb) or description.',
    shape: {
      id: z.string(),
      tag: z.string().min(1).optional(),
      color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .nullable()
        .optional(),
      description: z.string().nullable().optional(),
    },
    handler: async ({ id, ...fields }, ctx) => {
      const changes = Object.fromEntries(
        Object.entries(fields).filter(([, v]) => v !== undefined),
      );
      if (!Object.keys(changes).length) throw new Error('Nothing to update.');
      await api.updateTag(id, changes);
      await ctx.refresh();
      return { ok: true };
    },
  }),

  defineTool({
    name: 'delete_tag',
    write: true,
    description:
      'Delete a tag definition. Notes that mention it are unchanged.',
    shape: { id: z.string() },
    handler: async ({ id }, ctx) => {
      await api.deleteTag(id);
      await ctx.refresh();
      return { ok: true };
    },
  }),

  defineTool({
    name: 'set_notes',
    write: true,
    description:
      'Set (or clear, with an empty string) the notes of a category, account or budget month. Ids: "category-<id>", "account-<id>", "budget-<YYYY-MM>". Replaces the existing note, so read it with get_notes first and keep what should stay.',
    shape: { id: z.string(), note: z.string() },
    handler: async ({ id, note }, ctx) => {
      await api.updateNote(id, note);
      await ctx.refresh();
      return { ok: true };
    },
  }),
];
