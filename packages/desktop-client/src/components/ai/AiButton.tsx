import React from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Tooltip } from '@actual-app/components/tooltip';

import { toggleAiPanel, useAiPanelOpen } from '#ai/panelStore';
import { TablerGlyph } from '#components/common/EntityIcon/EntityIcon';

/** Titlebar button that opens the assistant. */
export function AiButton() {
  const { t } = useTranslation();
  const open = useAiPanelOpen();

  return (
    <Tooltip placement="bottom end" content={t('AI assistant')}>
      <Button
        variant="bare"
        aria-label={t('AI assistant')}
        aria-pressed={open}
        onPress={toggleAiPanel}
      >
        <TablerGlyph name="sparkles" size={15} />
      </Button>
    </Tooltip>
  );
}
