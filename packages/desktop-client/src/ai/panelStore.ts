import { useSyncExternalStore } from 'react';

// Whether the assistant panel is open. A tiny module-level store, so the
// titlebar button, the sidebar and the settings page can all toggle it.

/** Width of the docked assistant panel on wide screens. */
export const AI_DOCK_WIDTH = 420;

let open = false;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach(listener => listener());
}

export function setAiPanelOpen(next: boolean) {
  if (open === next) return;
  open = next;
  emit();
}

export function toggleAiPanel() {
  setAiPanelOpen(!open);
}

export function useAiPanelOpen(): boolean {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => open,
    () => false,
  );
}

// Bumped when AI settings are saved, so an open panel re-reads them.
let settingsVersion = 0;
const settingsListeners = new Set<() => void>();

export function notifyAiSettingsChanged() {
  settingsVersion += 1;
  settingsListeners.forEach(listener => listener());
}

export function useAiSettingsVersion(): number {
  return useSyncExternalStore(
    listener => {
      settingsListeners.add(listener);
      return () => settingsListeners.delete(listener);
    },
    () => settingsVersion,
    () => 0,
  );
}
