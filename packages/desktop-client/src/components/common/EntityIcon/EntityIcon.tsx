import React from 'react';
import type { CSSProperties } from 'react';

import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

import { getBank, getBankLogoUrl } from './bankLogos';
import { getContrastColor, isValidHexColor, parseIcon } from './iconUtils';
import { useTablerIcons } from './tablerIcons';

type EntityIconProps = {
  /** "<set>:<name>", e.g. "tabler:wallet" or "bank:nubank". */
  icon: string | null | undefined;
  /** Hex background color. Falls back to a neutral (or the bank's) color. */
  color?: string | null;
  /** Box size in px. */
  size?: number;
  style?: CSSProperties;
};

/**
 * A small rounded, colored square with an icon or bank logo, meant to sit to
 * the left of a category or account name. Renders nothing when there is no
 * valid icon, so callers can use it unconditionally.
 */
export function EntityIcon({ icon, color, size = 20, style }: EntityIconProps) {
  const parsed = parseIcon(icon);
  if (!parsed) {
    return null;
  }

  const bank = parsed.set === 'bank' ? getBank(parsed.name) : undefined;
  const customColor = isValidHexColor(color) ? color : undefined;
  const background = customColor ?? bank?.color;

  return (
    <View
      aria-hidden
      data-testid="entity-icon"
      data-icon={icon}
      style={{
        width: size,
        height: size,
        minWidth: size,
        borderRadius: Math.max(3, Math.round(size * 0.25)),
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        flexShrink: 0,
        backgroundColor: background ?? theme.pillBackground,
        color: background ? getContrastColor(background) : theme.pillText,
        ...style,
      }}
    >
      {parsed.set === 'tabler' ? (
        <TablerGlyph name={parsed.name} size={Math.round(size * 0.66)} />
      ) : (
        <BankLogo slug={parsed.name} />
      )}
    </View>
  );
}

export function TablerGlyph({ name, size }: { name: string; size: number }) {
  const tabler = useTablerIcons();
  const body = tabler?.getBody(name);
  if (!body) {
    return null;
  }
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      // The body comes from the bundled Tabler icon set, never from user input.
      dangerouslySetInnerHTML={{ __html: body }}
    />
  );
}

function BankLogo({ slug }: { slug: string }) {
  const url = getBankLogoUrl(slug);
  if (!url) {
    return null;
  }
  return (
    <img
      src={url}
      alt=""
      draggable={false}
      style={{ width: '100%', height: '100%', objectFit: 'contain' }}
    />
  );
}
