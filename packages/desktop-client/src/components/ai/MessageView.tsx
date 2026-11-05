import React from 'react';
import type { ReactNode } from 'react';

import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

import { isProposalTool } from '#ai/proposals';
import type { ChatMessage, MessagePart, ToolPart } from '#ai/types';
import { Markdown } from '#components/common/Markdown';

import { ProposalCard } from './ProposalCards';
import { QuestionCard } from './QuestionCard';
import { ToolChip } from './ToolChip';

// Chat answers often contain tables; the base markdown styles leave them bare.
const markdownStyle = {
  '& table': { borderCollapse: 'collapse', margin: '6px 0', fontSize: 13 },
  '& th, & td': {
    border: `1px solid ${theme.tableBorder}`,
    padding: '3px 8px',
    textAlign: 'left',
  },
  '& th': { backgroundColor: theme.tableRowHeaderBackground },
  '& p': { margin: '0 0 6px' },
} as const;

type Resolution = { answer: string; selected?: string[] } | { dismiss: true };

type MessageViewProps = {
  message: ChatMessage;
  /** The assistant is still producing this message. */
  live: boolean;
  onAnswer: (questionId: string, resolution: Resolution) => void;
};

export function MessageView({ message, live, onAnswer }: MessageViewProps) {
  if (message.role === 'user') {
    return (
      <View style={{ alignItems: 'flex-end' }}>
        <View
          style={{
            maxWidth: '85%',
            padding: '8px 12px',
            borderRadius: 12,
            backgroundColor: theme.buttonPrimaryBackground,
            color: theme.buttonPrimaryText,
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
          }}
        >
          {message.parts
            .map(part => (part.type === 'text' ? part.text : ''))
            .join('')}
        </View>
      </View>
    );
  }

  // Consecutive plain tool calls collapse into one row of chips.
  const blocks: ReactNode[] = [];
  let chips: ToolPart[] = [];
  const flushChips = () => {
    if (chips.length) {
      const group = chips;
      blocks.push(
        <View
          key={`chips-${group[0].id}`}
          style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}
        >
          {group.map(tool => (
            <ToolChip key={tool.id} tool={tool} />
          ))}
        </View>,
      );
      chips = [];
    }
  };

  message.parts.forEach((part: MessagePart, index) => {
    if (part.type === 'tool') {
      if (part.name === 'ask_user') return; // shown as a question card
      if (isProposalTool(part.name)) {
        flushChips();
        blocks.push(<ProposalCard key={part.id} tool={part} />);
      } else {
        chips.push(part);
      }
      return;
    }
    flushChips();
    if (part.type === 'text') {
      blocks.push(
        <View key={`text-${index}`} style={{ overflowWrap: 'anywhere' }}>
          <Markdown preserveBlankLines={false} style={markdownStyle}>
            {part.text}
          </Markdown>
        </View>,
      );
    } else {
      const waiting = live && index === message.parts.length - 1;
      blocks.push(
        <QuestionCard
          key={part.id}
          question={part}
          active={waiting}
          onResolve={resolution => onAnswer(part.id, resolution)}
        />,
      );
    }
  });
  flushChips();

  return <View style={{ gap: 8, maxWidth: '100%' }}>{blocks}</View>;
}
