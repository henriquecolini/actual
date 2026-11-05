import React, { useEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Select } from '@actual-app/components/select';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

import { aiApi } from '#ai/api';
import { setAiPanelOpen, useAiSettingsVersion } from '#ai/panelStore';
import type { AiStatus } from '#ai/types';
import { useAiChat } from '#ai/useAiChat';
import { TablerGlyph } from '#components/common/EntityIcon/EntityIcon';
import { useMetadataPref } from '#hooks/useMetadataPref';
import { useNavigate } from '#hooks/useNavigate';

import { MessageView } from './MessageView';

const NEW = '__new__';

export function AiChatPanel() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [fileId] = useMetadataPref('cloudFileId');
  const chat = useAiChat(fileId ?? null, i18n.language);
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<AiStatus | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const settingsVersion = useAiSettingsVersion();
  useEffect(() => {
    aiApi.status().then(setStatus, () => undefined);
  }, [settingsVersion]);

  // Follow the conversation while it streams, unless the user scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [chat.messages, chat.status]);

  const submit = (text: string) => {
    if (!text.trim() || chat.running) return;
    stickRef.current = true;
    setDraft('');
    void chat.send(text);
  };

  const starters = [
    t('Categorize my uncategorized transactions'),
    t('How am I doing this month?'),
    t('Where can I save money?'),
    t('Find my subscriptions'),
    t('Review my budget setup'),
    t('Suggest icons for my categories'),
  ];

  const lastMessage = chat.messages[chat.messages.length - 1];
  const waitingForAnswer =
    chat.running &&
    lastMessage?.role === 'assistant' &&
    lastMessage.parts.some(
      part =>
        part.type === 'question' &&
        part.answer === undefined &&
        !part.dismissed,
    );

  const unconfigured = status && !status.settings.configured;
  const conversationOptions: [string, string][] = [
    [NEW, t('New conversation')],
    ...chat.conversations.map(c => [c.id, c.title] as [string, string]),
  ];

  return (
    <View style={{ height: '100%', backgroundColor: theme.pageBackground }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          padding: '8px 10px',
          borderBottom: `1px solid ${theme.tableBorder}`,
        }}
      >
        <TablerGlyph name="sparkles" size={18} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Select
            bare
            options={conversationOptions}
            value={chat.activeId ?? NEW}
            onChange={value => {
              if (value === NEW) chat.newConversation();
              else void chat.openConversation(value);
            }}
            style={{ maxWidth: '100%' }}
          />
        </View>
        {chat.activeId && (
          <Button
            variant="bare"
            aria-label={t('Delete this conversation')}
            onPress={() => void chat.removeConversation(chat.activeId!)}
          >
            <TablerGlyph name="trash" size={16} />
          </Button>
        )}
        <Button
          variant="bare"
          aria-label={t('Assistant settings')}
          onPress={() => void navigate('/settings/ai')}
        >
          <TablerGlyph name="settings" size={16} />
        </Button>
        <Button
          variant="bare"
          aria-label={t('Close the assistant')}
          onPress={() => setAiPanelOpen(false)}
        >
          <TablerGlyph name="x" size={16} />
        </Button>
      </View>

      <div
        ref={scrollRef}
        onScroll={e => {
          const el = e.currentTarget;
          stickRef.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        style={{ flex: 1, overflowY: 'auto', padding: 12 }}
        data-testid="ai-messages"
      >
        <View style={{ gap: 14 }}>
          {!fileId && (
            <Text style={{ color: theme.pageTextSubdued }}>
              <Trans>
                The assistant works with budgets stored on your sync server.
                Upload this budget to your server to use it.
              </Trans>
            </Text>
          )}

          {fileId && unconfigured && (
            <View style={{ gap: 8, alignItems: 'flex-start' }}>
              <Text>
                <Trans>
                  Set up your AI assistant to get started. You can use your
                  Claude subscription or an API key (OpenRouter, DeepSeek and
                  others).
                </Trans>
              </Text>
              <Button
                variant="primary"
                onPress={() => void navigate('/settings/ai')}
              >
                <Trans>Set up the assistant</Trans>
              </Button>
            </View>
          )}

          {fileId && !unconfigured && chat.messages.length === 0 && (
            <View style={{ gap: 10 }}>
              <Text style={{ fontWeight: 600, fontSize: 16 }}>
                <Trans>How can I help with your budget?</Trans>
              </Text>
              <Text style={{ color: theme.pageTextSubdued, fontSize: 13 }}>
                <Trans>
                  I can look through your data, answer questions, categorize
                  transactions, spot problems and suggest changes. You approve
                  anything before it is applied.
                </Trans>
              </Text>
              <View style={{ gap: 6 }}>
                {starters.map(starter => (
                  <Button
                    key={starter}
                    style={{ justifyContent: 'flex-start', textAlign: 'left' }}
                    onPress={() => submit(starter)}
                  >
                    {starter}
                  </Button>
                ))}
              </View>
            </View>
          )}

          {chat.messages.map((message, index) => (
            <MessageView
              key={message.id}
              message={message}
              live={chat.running && index === chat.messages.length - 1}
              onAnswer={(id, resolution) =>
                void chat.answerQuestion(id, resolution)
              }
            />
          ))}

          {chat.running && (
            <Text
              style={{ fontSize: 12, color: theme.pageTextSubdued }}
              role="status"
            >
              {waitingForAnswer
                ? t('Waiting for your answer…')
                : (chat.status ?? t('Working…'))}
            </Text>
          )}

          {chat.error && (
            <View
              role="alert"
              style={{
                padding: 10,
                borderRadius: 6,
                backgroundColor: theme.errorBackground,
                color: theme.errorText,
                fontSize: 13,
              }}
            >
              {chat.error}
            </View>
          )}
        </View>
      </div>

      <View
        style={{
          padding: 10,
          borderTop: `1px solid ${theme.tableBorder}`,
          gap: 6,
        }}
      >
        <View style={{ flexDirection: 'row', gap: 6, alignItems: 'flex-end' }}>
          <textarea
            value={draft}
            rows={2}
            disabled={!fileId || Boolean(unconfigured)}
            placeholder={t('Ask about your budget…')}
            aria-label={t('Message to the assistant')}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (
                e.key === 'Enter' &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                submit(draft);
              }
            }}
            style={{
              flex: 1,
              resize: 'none',
              padding: 8,
              borderRadius: 6,
              border: `1px solid ${theme.tableBorder}`,
              backgroundColor: theme.tableBackground,
              color: theme.pageText,
              font: 'inherit',
            }}
          />
          {chat.running ? (
            <Button aria-label={t('Stop')} onPress={chat.stop}>
              <TablerGlyph name="player-stop-filled" size={16} />
            </Button>
          ) : (
            <Button
              variant="primary"
              aria-label={t('Send')}
              isDisabled={!draft.trim() || !fileId || Boolean(unconfigured)}
              onPress={() => submit(draft)}
            >
              <TablerGlyph name="send" size={16} />
            </Button>
          )}
        </View>
      </View>
    </View>
  );
}
