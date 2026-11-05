import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

import type { ToolPart } from '#ai/types';

/** A friendly label for a tool call, in the user's language. */
function useToolLabel() {
  const { t } = useTranslation();
  const labels: Record<string, string> = {
    get_overview: t('Looked at your budget overview'),
    list_accounts: t('Checked your accounts'),
    list_categories: t('Looked at your categories'),
    get_budget_month: t('Looked at a budget month'),
    list_budget_months: t('Checked the budget months'),
    search_transactions: t('Searched transactions'),
    list_payees: t('Looked at your payees'),
    list_rules: t('Looked at your rules'),
    list_schedules: t('Looked at your schedules'),
    list_tags: t('Looked at your tags'),
    get_notes: t('Read your notes'),
    run_query: t('Ran a custom query'),
    describe_schema: t('Checked the data schema'),
    refresh_data: t('Refreshed your data'),
    spending_by: t('Analyzed spending'),
    income_vs_expense: t('Compared income and expenses'),
    category_trend: t('Looked at a spending trend'),
    net_worth_over_time: t('Looked at net worth over time'),
    uncategorized_summary: t('Summarized uncategorized transactions'),
    payee_category_history: t('Checked how payees were categorized'),
    find_recurring: t('Looked for recurring payments'),
    find_duplicates: t('Looked for duplicate transactions'),
    find_anomalies: t('Looked for unusual spending'),
    budget_health: t('Checked your budget health'),
    search_icons: t('Searched icons'),
  };
  return (name: string) => labels[name] ?? name.replace(/_/g, ' ');
}

export function ToolChip({ tool }: { tool: ToolPart }) {
  const label = useToolLabel()(tool.name);
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const running = !tool.result;
  const failed = tool.result?.isError;

  return (
    <View style={{ alignItems: 'flex-start' }}>
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        aria-label={t('Show details: {{label}}', { label })}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '2px 8px',
          borderRadius: 10,
          border: `1px solid ${theme.tableBorder}`,
          background: 'transparent',
          color: failed ? theme.errorText : theme.pageTextSubdued,
          fontSize: 12,
          cursor: 'pointer',
        }}
      >
        <span aria-hidden>{running ? '…' : failed ? '!' : '✓'}</span>
        <span>{label}</span>
      </button>
      {open && (
        <View
          style={{
            marginTop: 4,
            padding: 8,
            borderRadius: 6,
            backgroundColor: theme.tableRowHeaderBackground,
            maxWidth: '100%',
          }}
        >
          <Text style={{ fontSize: 11, color: theme.pageTextSubdued }}>
            <code style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {JSON.stringify(tool.input, null, 1)}
            </code>
          </Text>
          {tool.result && (
            <Text style={{ fontSize: 11, marginTop: 6 }}>
              <code style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {tool.result.text.slice(0, 1500)}
              </code>
            </Text>
          )}
        </View>
      )}
    </View>
  );
}
