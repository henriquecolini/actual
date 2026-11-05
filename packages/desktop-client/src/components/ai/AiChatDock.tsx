import React from 'react';

import { useResponsive } from '@actual-app/components/hooks/useResponsive';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

import { AI_DOCK_WIDTH, useAiPanelOpen } from '#ai/panelStore';

import { AiChatPanel } from './AiChatPanel';

/** The assistant: docked beside the page on wide screens, full screen on narrow ones. */
export function AiChatDock() {
  const open = useAiPanelOpen();
  const { isNarrowWidth } = useResponsive();
  if (!open) return null;

  if (isNarrowWidth) {
    return (
      <View
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 2000,
          backgroundColor: theme.pageBackground,
        }}
      >
        <AiChatPanel />
      </View>
    );
  }

  return (
    <View
      style={{
        width: AI_DOCK_WIDTH,
        flexShrink: 0,
        height: '100%',
        borderLeft: `1px solid ${theme.tableBorder}`,
      }}
    >
      <AiChatPanel />
    </View>
  );
}
