import React, { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Input } from '@actual-app/components/input';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

import type { QuestionPart } from '#ai/types';

type Resolution = { answer: string; selected?: string[] } | { dismiss: true };

type QuestionCardProps = {
  question: QuestionPart;
  /** Can be answered (the run is still waiting). */
  active: boolean;
  onResolve: (resolution: Resolution) => void;
};

/** The assistant asks the user to choose something. Options are buttons; free text is optional. */
export function QuestionCard({
  question,
  active,
  onResolve,
}: QuestionCardProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const done = question.answer !== undefined || question.dismissed;
  const waiting = active && !done;
  const options = question.options ?? [];
  const allowFreeText = question.allowFreeText ?? options.length === 0;

  const submit = (resolution: Resolution) => {
    setSubmitted(true);
    onResolve(resolution);
  };

  return (
    <View
      role="group"
      aria-label={t('Question from the assistant')}
      style={{
        gap: 10,
        padding: 12,
        borderRadius: 8,
        border: `1px solid ${waiting ? theme.pageTextLink : theme.tableBorder}`,
        backgroundColor: theme.tableBackground,
      }}
    >
      <Text style={{ fontWeight: 600 }}>{question.question}</Text>
      {question.context && (
        <Text style={{ fontSize: 12, color: theme.pageTextSubdued }}>
          {question.context}
        </Text>
      )}

      {done ? (
        <Text style={{ fontSize: 13, color: theme.pageTextSubdued }}>
          {question.dismissed ? (
            <Trans>Skipped</Trans>
          ) : (
            <Trans>You answered: {{ answer: question.answer }}</Trans>
          )}
        </Text>
      ) : (
        <>
          {options.length > 0 && (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {options.map(option => {
                const isSelected = selected.includes(option);
                return (
                  <Button
                    key={option}
                    variant={isSelected ? 'primary' : 'normal'}
                    isDisabled={!waiting || submitted}
                    aria-pressed={question.multi ? isSelected : undefined}
                    onPress={() => {
                      if (question.multi) {
                        setSelected(current =>
                          current.includes(option)
                            ? current.filter(o => o !== option)
                            : [...current, option],
                        );
                      } else {
                        submit({ answer: option, selected: [option] });
                      }
                    }}
                  >
                    {option}
                  </Button>
                );
              })}
            </View>
          )}

          {question.multi && options.length > 0 && (
            <View style={{ flexDirection: 'row' }}>
              <Button
                variant="primary"
                isDisabled={!waiting || submitted || selected.length === 0}
                onPress={() =>
                  submit({ answer: selected.join(', '), selected })
                }
              >
                <Trans>Confirm</Trans>
              </Button>
            </View>
          )}

          {allowFreeText && (
            <View style={{ flexDirection: 'row', gap: 6 }}>
              <Input
                value={text}
                placeholder={
                  options.length > 0
                    ? t('Or type your own answer')
                    : t('Type your answer')
                }
                disabled={!waiting || submitted}
                onChangeValue={setText}
                onEnter={() => {
                  if (text.trim()) submit({ answer: text.trim() });
                }}
                style={{ flex: 1 }}
              />
              <Button
                isDisabled={!waiting || submitted || !text.trim()}
                onPress={() => submit({ answer: text.trim() })}
              >
                <Trans>Send</Trans>
              </Button>
            </View>
          )}

          {waiting && (
            <View style={{ flexDirection: 'row' }}>
              <Button
                variant="bare"
                isDisabled={submitted}
                onPress={() => submit({ dismiss: true })}
              >
                <Trans>Skip</Trans>
              </Button>
            </View>
          )}
        </>
      )}
    </View>
  );
}
