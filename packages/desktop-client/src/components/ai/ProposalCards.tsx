import React, { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { q } from '@actual-app/core/shared/query';

import {
  applyBudgetChanges,
  applyCategorization,
  applyIcons,
  applyRule,
  parseProposal,
} from '#ai/proposals';
import type {
  BudgetProposal,
  CategorizationProposal,
  IconsProposal,
  RuleProposal,
} from '#ai/proposals';
import type { ToolPart } from '#ai/types';
import { EntityIcon } from '#components/common/EntityIcon/EntityIcon';
import { useAccounts } from '#hooks/useAccounts';
import { useCategories } from '#hooks/useCategories';
import { useFormat } from '#hooks/useFormat';
import { aqlQuery } from '#queries/aqlQuery';

// ---------------------------------------------------------------- shared shell

type StoredState = { applied: boolean; dismissed: boolean };

/** Remembers, per proposal, whether it was applied or dismissed (survives reloads). */
function useProposalState(id: string) {
  const key = `actual-ai-proposal-${id}`;
  const [state, setState] = useState<StoredState>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw) return JSON.parse(raw) as StoredState;
    } catch {
      // storage unavailable: start fresh
    }
    return { applied: false, dismissed: false };
  });
  const update = (next: Partial<StoredState>) => {
    const merged = { ...state, ...next };
    setState(merged);
    try {
      localStorage.setItem(key, JSON.stringify(merged));
    } catch {
      // not persisted; fine
    }
  };
  return [state, update] as const;
}

type ShellProps = {
  title: ReactNode;
  subtitle?: ReactNode;
  state: StoredState;
  children: ReactNode;
  /** Shown beside the apply button. */
  summary?: ReactNode;
  applyLabel: ReactNode;
  canApply: boolean;
  onApply: () => Promise<void>;
  onDismiss: () => void;
};

function Shell({
  title,
  subtitle,
  state,
  children,
  summary,
  applyLabel,
  canApply,
  onApply,
  onDismiss,
}: ShellProps) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = async () => {
    setWorking(true);
    setError(null);
    try {
      await onApply();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  };

  return (
    <View
      style={{
        gap: 8,
        padding: 12,
        borderRadius: 8,
        border: `1px solid ${theme.tableBorder}`,
        backgroundColor: theme.tableBackground,
        opacity: state.dismissed ? 0.6 : 1,
      }}
    >
      <View style={{ gap: 2 }}>
        <Text style={{ fontWeight: 600 }}>{title}</Text>
        {subtitle && (
          <Text style={{ fontSize: 12, color: theme.pageTextSubdued }}>
            {subtitle}
          </Text>
        )}
      </View>

      {!state.dismissed && children}

      {error && (
        <Text style={{ color: theme.errorText, fontSize: 13 }}>{error}</Text>
      )}

      {state.applied ? (
        <Text style={{ fontSize: 13, color: theme.noticeText }}>
          <Trans>Applied. You can undo it with Ctrl/⌘+Z.</Trans>
        </Text>
      ) : state.dismissed ? (
        <Text style={{ fontSize: 13, color: theme.pageTextSubdued }}>
          <Trans>Dismissed</Trans>
        </Text>
      ) : (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Button
            variant="primary"
            isDisabled={!canApply || working}
            onPress={() => void apply()}
          >
            {applyLabel}
          </Button>
          <Button variant="bare" isDisabled={working} onPress={onDismiss}>
            <Trans>Dismiss</Trans>
          </Button>
          {summary && (
            <Text style={{ fontSize: 12, color: theme.pageTextSubdued }}>
              {summary}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

const confidenceColor = (confidence: string) =>
  confidence === 'high'
    ? theme.noticeText
    : confidence === 'medium'
      ? theme.warningText
      : theme.errorText;

// ------------------------------------------------------------ categorization

type TxInfo = {
  date: string;
  amount: number;
  payee: string | null;
  account: string;
};

function useTransactions(ids: string[]) {
  const [info, setInfo] = useState<Record<string, TxInfo>>({});
  const key = ids.join(',');
  useEffect(() => {
    let cancelled = false;
    void aqlQuery(
      q('transactions')
        .filter({ id: { $oneof: ids } })
        .select(['id', 'date', 'amount', 'payee.name', 'account.name']),
    ).then(({ data }: { data: Record<string, unknown>[] }) => {
      if (cancelled) return;
      setInfo(
        Object.fromEntries(
          data.map(row => [
            String(row.id),
            {
              date: String(row.date),
              amount: Number(row.amount),
              payee: (row['payee.name'] as string | null) ?? null,
              account: String(row['account.name'] ?? ''),
            },
          ]),
        ),
      );
    });
    return () => {
      cancelled = true;
    };
    // ids are captured through key
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return info;
}

function CategorizationCard({
  id,
  proposal,
}: {
  id: string;
  proposal: CategorizationProposal;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const { data: categories } = useCategories();
  const [state, update] = useProposalState(id);
  const info = useTransactions(proposal.items.map(i => i.transaction_id));
  const [selected, setSelected] = useState(
    () =>
      new Set(
        proposal.items
          .filter(i => i.confidence !== 'low')
          .map(i => i.transaction_id),
      ),
  );
  const byId = new Map((categories?.list ?? []).map(c => [c.id, c]));

  const toggle = (txId: string) =>
    setSelected(current => {
      const next = new Set(current);
      if (next.has(txId)) next.delete(txId);
      else next.add(txId);
      return next;
    });

  const chosen = proposal.items.filter(i => selected.has(i.transaction_id));

  return (
    <Shell
      title={proposal.title ?? t('Suggested categories')}
      subtitle={t('{{count}} transactions', { count: proposal.items.length })}
      state={state}
      applyLabel={t('Apply {{count}}', { count: chosen.length })}
      canApply={chosen.length > 0}
      onApply={async () => {
        await applyCategorization(chosen);
        update({ applied: true });
      }}
      onDismiss={() => update({ dismissed: true })}
      summary={
        <Button
          variant="bare"
          onPress={() =>
            setSelected(
              selected.size === proposal.items.length
                ? new Set()
                : new Set(proposal.items.map(i => i.transaction_id)),
            )
          }
        >
          {selected.size === proposal.items.length
            ? t('Select none')
            : t('Select all')}
        </Button>
      }
    >
      <View style={{ gap: 2, maxHeight: 320, overflowY: 'auto' }}>
        {proposal.items.map(item => {
          const tx = info[item.transaction_id];
          const category = byId.get(item.category_id);
          return (
            <label
              key={item.transaction_id}
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'flex-start',
                padding: '6px 4px',
                borderRadius: 4,
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={selected.has(item.transaction_id)}
                onChange={() => toggle(item.transaction_id)}
                style={{ marginTop: 3 }}
              />
              <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
                <View
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    gap: 8,
                  }}
                >
                  <Text
                    style={{
                      fontSize: 13,
                      fontWeight: 500,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {tx?.payee ?? '…'}
                  </Text>
                  {tx && (
                    <Text style={{ fontSize: 13 }}>
                      {format(tx.amount, 'financial')}
                    </Text>
                  )}
                </View>
                <View
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
                >
                  <Text style={{ fontSize: 12, color: theme.pageTextSubdued }}>
                    {tx?.date ?? ''} →
                  </Text>
                  <EntityIcon
                    icon={category?.icon}
                    color={category?.icon_color}
                    size={14}
                  />
                  <Text style={{ fontSize: 12, fontWeight: 600 }}>
                    {category?.name ?? item.category_id}
                  </Text>
                  <Text
                    style={{
                      fontSize: 11,
                      color: confidenceColor(item.confidence),
                    }}
                  >
                    {item.confidence}
                  </Text>
                </View>
                <Text style={{ fontSize: 11, color: theme.pageTextSubdued }}>
                  {item.reason}
                </Text>
              </View>
            </label>
          );
        })}
      </View>
    </Shell>
  );
}

// -------------------------------------------------------------------- rules

function describeValue(value: unknown): string {
  return Array.isArray(value) ? value.join(', ') : String(value);
}

function RuleCard({ id, proposal }: { id: string; proposal: RuleProposal }) {
  const { t } = useTranslation();
  const { data: categories } = useCategories();
  const [state, update] = useProposalState(id);
  const byId = new Map((categories?.list ?? []).map(c => [c.id, c.name]));
  const label = (field: string, value: unknown) =>
    field === 'category'
      ? (byId.get(String(value)) ?? describeValue(value))
      : describeValue(value);

  return (
    <Shell
      title={proposal.name}
      subtitle={t('Automation rule')}
      state={state}
      applyLabel={t('Create rule')}
      canApply
      onApply={async () => {
        await applyRule(proposal);
        update({ applied: true });
      }}
      onDismiss={() => update({ dismissed: true })}
    >
      <View style={{ gap: 4 }}>
        <Text style={{ fontSize: 13 }}>
          <Trans>When</Trans>{' '}
          {proposal.conditions
            .map(c => `${c.field} ${c.op} "${label(c.field, c.value)}"`)
            .join(
              proposal.conditions_op === 'or'
                ? ` ${t('or')} `
                : ` ${t('and')} `,
            )}
        </Text>
        <Text style={{ fontSize: 13 }}>
          <Trans>then</Trans>{' '}
          {proposal.actions
            .map(a => `${t('set')} ${a.field} → ${label(a.field, a.value)}`)
            .join(', ')}
        </Text>
        {proposal.reason && (
          <Text style={{ fontSize: 12, color: theme.pageTextSubdued }}>
            {proposal.reason}
          </Text>
        )}
      </View>
    </Shell>
  );
}

// ------------------------------------------------------------------- budget

function BudgetCard({
  id,
  proposal,
}: {
  id: string;
  proposal: BudgetProposal;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const { data: categories } = useCategories();
  const [state, update] = useProposalState(id);
  const byId = new Map((categories?.list ?? []).map(c => [c.id, c]));

  return (
    <Shell
      title={t('Budget changes for {{month}}', { month: proposal.month })}
      subtitle={t('{{count}} categories', { count: proposal.changes.length })}
      state={state}
      applyLabel={t('Apply changes')}
      canApply
      onApply={async () => {
        await applyBudgetChanges(proposal.month, proposal.changes);
        update({ applied: true });
      }}
      onDismiss={() => update({ dismissed: true })}
    >
      <View style={{ gap: 4 }}>
        {proposal.changes.map(change => {
          const category = byId.get(change.category_id);
          return (
            <View key={change.category_id} style={{ gap: 1 }}>
              <View
                style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
              >
                <EntityIcon
                  icon={category?.icon}
                  color={category?.icon_color}
                  size={14}
                />
                <Text style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>
                  {category?.name ?? change.category_id}
                </Text>
                <Text style={{ fontSize: 13 }}>
                  {format(Math.round(change.budgeted * 100), 'financial')}
                </Text>
              </View>
              <Text style={{ fontSize: 11, color: theme.pageTextSubdued }}>
                {change.reason}
              </Text>
            </View>
          );
        })}
      </View>
    </Shell>
  );
}

// -------------------------------------------------------------------- icons

function IconsCard({ id, proposal }: { id: string; proposal: IconsProposal }) {
  const { t } = useTranslation();
  const { data: categories } = useCategories();
  const { data: accounts } = useAccounts();
  const [state, update] = useProposalState(id);
  const names = new Map<string, string>([
    ...(categories?.list ?? []).map(c => [c.id, c.name] as const),
    ...(accounts ?? []).map(a => [a.id, a.name] as const),
  ]);

  return (
    <Shell
      title={t('Suggested icons')}
      subtitle={t('{{count}} items', { count: proposal.items.length })}
      state={state}
      applyLabel={t('Apply icons')}
      canApply
      onApply={async () => {
        await applyIcons(proposal.items);
        update({ applied: true });
      }}
      onDismiss={() => update({ dismissed: true })}
    >
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {proposal.items.map(item => (
          <View
            key={item.id}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              minWidth: 140,
            }}
          >
            <EntityIcon icon={item.icon} color={item.color} size={22} />
            <Text style={{ fontSize: 13 }}>
              {names.get(item.id) ?? item.id}
            </Text>
          </View>
        ))}
      </View>
    </Shell>
  );
}

// -------------------------------------------------------------------- entry

export function ProposalCard({ tool }: { tool: ToolPart }) {
  if (!tool.result) {
    return (
      <Text style={{ fontSize: 12, color: theme.pageTextSubdued }}>
        <Trans>Preparing suggestions…</Trans>
      </Text>
    );
  }
  const proposal = parseProposal(tool);
  if (!proposal) return null;
  switch (proposal.kind) {
    case 'categorization':
      return <CategorizationCard id={tool.id} proposal={proposal} />;
    case 'rule':
      return <RuleCard id={tool.id} proposal={proposal} />;
    case 'budget':
      return <BudgetCard id={tool.id} proposal={proposal} />;
    case 'icons':
      return <IconsCard id={tool.id} proposal={proposal} />;
    default:
      return null;
  }
}
