// Icons are stored as a single "<set>:<name>" string on categories and
// accounts, next to a separate `icon_color` background color.

export type ParsedIcon =
  | { set: 'tabler'; name: string }
  | { set: 'bank'; name: string };

export function makeIcon(set: ParsedIcon['set'], name: string): string {
  return `${set}:${name}`;
}

export function parseIcon(
  icon: string | null | undefined,
): ParsedIcon | undefined {
  if (!icon) {
    return undefined;
  }
  const separator = icon.indexOf(':');
  if (separator === -1) {
    return undefined;
  }
  const set = icon.slice(0, separator);
  const name = icon.slice(separator + 1);
  if (!name || (set !== 'tabler' && set !== 'bank')) {
    return undefined;
  }
  return { set, name };
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function isValidHexColor(color: string | null | undefined): boolean {
  return !!color && HEX_COLOR.test(color);
}

/** Black or white, whichever reads better on the given background. */
export function getContrastColor(background: string): '#000000' | '#ffffff' {
  if (!isValidHexColor(background)) {
    return '#ffffff';
  }
  const channel = (offset: number) => {
    const value = parseInt(background.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  // Threshold where black and white text have equal contrast ratio.
  return luminance > 0.179 ? '#000000' : '#ffffff';
}

export const ICON_COLOR_PRESETS: readonly string[] = [
  '#ef4444',
  '#f97316',
  '#f59e0b',
  '#eab308',
  '#84cc16',
  '#22c55e',
  '#10b981',
  '#14b8a6',
  '#06b6d4',
  '#0ea5e9',
  '#3b82f6',
  '#6366f1',
  '#8b5cf6',
  '#a855f7',
  '#d946ef',
  '#ec4899',
  '#f43f5e',
  '#78716c',
  '#475569',
  '#111827',
];
