import React, { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Input } from '@actual-app/components/input';
import { Select } from '@actual-app/components/select';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

import { aiApi } from '#ai/api';
import { notifyAiSettingsChanged, setAiPanelOpen } from '#ai/panelStore';
import type { AiStatus, McpTokenInfo, RuntimeId } from '#ai/types';
import { Link } from '#components/common/Link';
import { useServerURL } from '#components/ServerContext';
import { SettingsGroup } from '#components/settings/SettingsGroup';
import { useMetadataPref } from '#hooks/useMetadataPref';
import { useNavigate } from '#hooks/useNavigate';

const field = { gap: 4 } as const;
const label = { fontSize: 13, fontWeight: 500 } as const;
const hint = {
  fontSize: 12,
  color: theme.pageTextSubdued,
  lineHeight: 1.5,
} as const;

export function AiSettingsContent() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [runtime, setRuntime] = useState<RuntimeId>('claude_code');
  const [provider, setProvider] = useState<string>('openrouter');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [secret, setSecret] = useState('');
  const [allowWrites, setAllowWrites] = useState(false);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  useEffect(() => {
    aiApi.status().then(
      loaded => {
        setStatus(loaded);
        const s = loaded.settings;
        setRuntime(s.runtime);
        setProvider(s.provider ?? 'openrouter');
        setBaseUrl(s.baseUrl ?? '');
        setModel(s.model ?? '');
        setAllowWrites(s.allowWrites);
      },
      () => setLoadError(t('Could not reach the sync server.')),
    );
  }, [t]);

  const providers = status?.providers ?? [];
  const selectedProvider = providers.find(p => p.id === provider);
  const modelSuggestions =
    runtime === 'claude_code'
      ? (status?.claudeModels ?? [])
      : (selectedProvider?.models ?? []);

  const input = () => ({
    runtime,
    provider: runtime === 'openai_compat' ? provider : null,
    baseUrl:
      runtime === 'openai_compat' && selectedProvider?.needsBaseUrl
        ? baseUrl
        : null,
    model: model || null,
    allowWrites,
    ...(secret ? { secret } : {}),
  });

  const run = async (kind: 'save' | 'test') => {
    setBusy(kind);
    setMessage(null);
    try {
      if (kind === 'test') {
        const result = await aiApi.testSettings(input());
        setMessage({ ok: result.ok, text: result.message });
      } else {
        const saved = await aiApi.saveSettings(input());
        setStatus(current =>
          current ? { ...current, settings: saved } : current,
        );
        setSecret('');
        notifyAiSettingsChanged();
        setMessage({ ok: true, text: t('Saved.') });
      }
    } catch (error) {
      setMessage({
        ok: false,
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(null);
    }
  };

  if (loadError) {
    return (
      <SettingsGroup title={t('AI Assistant')}>
        <Text style={{ padding: 16 }}>{loadError}</Text>
      </SettingsGroup>
    );
  }

  const hasSecret = status?.settings.hasSecret && !secret;

  return (
    <>
      <SettingsGroup
        title={t('AI Assistant')}
        description={
          <Trans>
            Chat with an assistant that knows your budget, categorizes
            transactions and suggests improvements. It runs on your server using
            your own Claude subscription or API key, and changes nothing until
            you approve it.
          </Trans>
        }
      >
        <View style={{ gap: 16, padding: 16 }}>
          <View style={field}>
            <Text style={label}>
              <Trans>Connect with</Trans>
            </Text>
            <Select<RuntimeId>
              options={[
                ['claude_code', t('Claude subscription (Claude Code)')],
                [
                  'openai_compat',
                  t('API key (OpenRouter, DeepSeek, OpenAI, …)'),
                ],
              ]}
              value={runtime}
              onChange={value => {
                setRuntime(value);
                setModel('');
                setMessage(null);
              }}
            />
          </View>

          {runtime === 'openai_compat' && (
            <View style={field}>
              <Text style={label}>
                <Trans>Provider</Trans>
              </Text>
              <Select<string>
                options={providers.map(
                  p => [p.id, p.label] as [string, string],
                )}
                value={provider}
                onChange={value => {
                  setProvider(value);
                  setModel('');
                  setMessage(null);
                }}
              />
              {selectedProvider?.keyUrl && (
                <Text style={hint}>
                  <Link variant="external" to={selectedProvider.keyUrl}>
                    <Trans>Get an API key</Trans>
                  </Link>
                </Text>
              )}
            </View>
          )}

          {runtime === 'openai_compat' && selectedProvider?.needsBaseUrl && (
            <View style={field}>
              <Text style={label}>
                <Trans>Server URL</Trans>
              </Text>
              <Input
                value={baseUrl}
                placeholder="http://localhost:11434/v1"
                onChangeValue={setBaseUrl}
              />
            </View>
          )}

          <View style={field}>
            <Text style={label}>
              {runtime === 'claude_code' ? t('Claude token') : t('API key')}
            </Text>
            <Input
              type="password"
              autoComplete="off"
              value={secret}
              placeholder={
                hasSecret
                  ? `${status?.settings.secretPreview ?? '••••'} (${t('saved')})`
                  : runtime === 'claude_code'
                    ? 'sk-ant-oat01-…'
                    : 'sk-…'
              }
              onChangeValue={setSecret}
            />
            <Text style={hint}>
              {runtime === 'claude_code' ? (
                <Trans>
                  On a computer with Claude Code installed, run{' '}
                  <code>claude setup-token</code> and paste the token here. It
                  uses your Claude subscription, and is stored encrypted on your
                  server, only for your account.
                </Trans>
              ) : (
                <Trans>
                  Stored encrypted on your server, only for your account. Leave
                  empty to keep the saved key.
                </Trans>
              )}
            </Text>
          </View>

          <View style={field}>
            <Text style={label}>
              <Trans>Model</Trans>
            </Text>
            <Input
              value={model}
              list="ai-model-suggestions"
              placeholder={modelSuggestions[0] ?? ''}
              onChangeValue={setModel}
            />
            <datalist id="ai-model-suggestions">
              {modelSuggestions.map(m => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <Text style={hint}>
              <Trans>Leave empty to use the suggested model.</Trans>
            </Text>
          </View>

          <View style={field}>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                aria-label={t('Let the assistant make changes directly')}
                checked={allowWrites}
                onChange={event => setAllowWrites(event.target.checked)}
              />
              <Text style={label}>
                <Trans>Let the assistant make changes directly</Trans>
              </Text>
            </label>
            <Text style={hint}>
              <Trans>
                When on, the assistant can edit your budget without asking you
                to approve each change: transactions, accounts, categories,
                budget amounts, rules and more. It still asks before deleting or
                making large changes. Changes sync right away and can&apos;t be
                undone with Undo. When off, it can only propose changes for you
                to review.
              </Trans>
            </Text>
          </View>

          <View
            style={{
              flexDirection: 'row',
              gap: 8,
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            <Button
              variant="primary"
              isDisabled={busy !== null}
              onPress={() => void run('save')}
            >
              <Trans>Save</Trans>
            </Button>
            <Button isDisabled={busy !== null} onPress={() => void run('test')}>
              {busy === 'test' ? t('Testing…') : t('Test connection')}
            </Button>
            {status?.settings.configured && (
              <Button
                variant="bare"
                onPress={() => {
                  setAiPanelOpen(true);
                  void navigate('/budget');
                }}
              >
                <Trans>Open the assistant</Trans>
              </Button>
            )}
          </View>
          {message && (
            <Text
              role="status"
              style={{
                fontSize: 13,
                color: message.ok ? theme.noticeText : theme.errorText,
              }}
            >
              {message.text}
            </Text>
          )}
        </View>
      </SettingsGroup>

      <McpAccess />
    </>
  );
}

function McpAccess() {
  const { t } = useTranslation();
  const serverUrl = useServerURL();
  const [groupId] = useMetadataPref('groupId');
  const [tokens, setTokens] = useState<McpTokenInfo[]>([]);
  const [labelText, setLabelText] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = () => {
    aiApi.listMcpTokens().then(setTokens, () => undefined);
  };
  useEffect(load, []);

  const command = (token: string) =>
    [
      'claude mcp add actual \\',
      `  -e ACTUAL_SERVER_URL=${serverUrl} \\`,
      `  -e ACTUAL_SESSION_TOKEN=${token} \\`,
      `  -e ACTUAL_SYNC_ID=${groupId ?? '<sync id>'} \\`,
      '  -e ACTUAL_DATA_DIR=$HOME/.actual-mcp \\',
      '  -- node /path/to/actual/packages/mcp-server/dist/mcp.js',
    ].join('\n');

  return (
    <SettingsGroup
      title={t('Use from other AI tools')}
      description={
        <Trans>
          Give another MCP-compatible tool (such as Claude Code on your
          computer) read access to this budget. Create a token, then run the
          command shown once.
        </Trans>
      }
    >
      <View style={{ gap: 12, padding: 16 }}>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Input
            value={labelText}
            placeholder={t('Name, e.g. My laptop')}
            onChangeValue={setLabelText}
            style={{ flex: 1 }}
          />
          <Button
            onPress={() => {
              aiApi.createMcpToken(labelText).then(
                result => {
                  setCreated(result.token);
                  setCopied(false);
                  setLabelText('');
                  load();
                },
                () => undefined,
              );
            }}
          >
            <Trans>Create token</Trans>
          </Button>
        </View>

        {created && (
          <View style={{ gap: 6 }}>
            <Text style={hint}>
              <Trans>
                Copy this now. For your security it will not be shown again.
              </Trans>
            </Text>
            <pre
              style={{
                margin: 0,
                padding: 10,
                borderRadius: 6,
                overflowX: 'auto',
                fontSize: 12,
                backgroundColor: theme.tableRowHeaderBackground,
              }}
            >
              {command(created)}
            </pre>
            <View style={{ flexDirection: 'row' }}>
              <Button
                onPress={() => {
                  void navigator.clipboard
                    ?.writeText(command(created))
                    .then(() => setCopied(true));
                }}
              >
                {copied ? t('Copied') : t('Copy command')}
              </Button>
            </View>
          </View>
        )}

        {tokens.map(token => (
          <View
            key={token.id}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
          >
            <Text style={{ flex: 1, fontSize: 13 }}>
              {token.label ?? t('Unnamed token')} ·{' '}
              <span style={{ color: theme.pageTextSubdued }}>
                {new Date(token.createdAt).toLocaleDateString()}
              </span>
            </Text>
            <Button
              variant="bare"
              onPress={() => {
                aiApi.revokeMcpToken(token.id).then(load, () => undefined);
              }}
            >
              <Trans>Revoke</Trans>
            </Button>
          </View>
        ))}
      </View>
    </SettingsGroup>
  );
}
