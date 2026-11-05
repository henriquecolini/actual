import React, { useMemo, useState } from 'react';
import type { RefObject } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Popover } from '@actual-app/components/popover';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

import { Search } from '#components/common/Search';

import { BANKS, getBankLogoUrl } from './bankLogos';
import { EntityIcon } from './EntityIcon';
import {
  ICON_COLOR_PRESETS,
  isValidHexColor,
  makeIcon,
  parseIcon,
} from './iconUtils';
import { useTablerIcons } from './tablerIcons';

export type IconSelection = {
  icon: string | null;
  color: string | null;
};

type IconPickerProps = {
  value: IconSelection;
  onChange: (value: IconSelection) => void;
  /** Bank logos are only offered for accounts. */
  allowBanks?: boolean;
};

const CELL_SIZE = 36;
const COLUMNS = 8;
const GRID_HEIGHT = 252;
const OVERSCAN_ROWS = 2;

export function IconPicker({
  value: savedValue,
  onChange,
  allowBanks = false,
}: IconPickerProps) {
  const { t } = useTranslation();
  // The saved value only comes back after a round trip to the backend, so keep
  // the selection locally. Otherwise two quick changes (an icon, then a color)
  // would each be merged into the stale saved value and the first would be lost.
  const [value, setValue] = useState(savedValue);
  const commit = (next: IconSelection) => {
    setValue(next);
    onChange(next);
  };
  const parsed = parseIcon(value.icon);
  const [tab, setTab] = useState<'icons' | 'banks'>(
    allowBanks && parsed?.set === 'bank' ? 'banks' : 'icons',
  );
  const [search, setSearch] = useState('');

  return (
    <View
      style={{
        width: COLUMNS * CELL_SIZE + 24,
        maxWidth: '100%',
        padding: 12,
        gap: 10,
      }}
    >
      <View
        style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}
        data-testid="icon-picker-preview"
      >
        {value.icon ? (
          <EntityIcon icon={value.icon} color={value.color} size={28} />
        ) : (
          <View
            style={{
              width: 28,
              height: 28,
              borderRadius: 7,
              border: `1px dashed ${theme.tableBorder}`,
            }}
          />
        )}
        <Text style={{ flex: 1, color: theme.pageTextSubdued }}>
          {parsed ? parsed.name : t('No icon')}
        </Text>
        {(value.icon || value.color) && (
          <Button
            variant="bare"
            onPress={() => commit({ icon: null, color: null })}
          >
            <Trans>Remove</Trans>
          </Button>
        )}
      </View>

      {allowBanks && (
        <View style={{ flexDirection: 'row', gap: 5 }}>
          <Button
            variant={tab === 'icons' ? 'menuSelected' : 'bare'}
            onPress={() => setTab('icons')}
          >
            <Trans>Icons</Trans>
          </Button>
          <Button
            variant={tab === 'banks' ? 'menuSelected' : 'bare'}
            onPress={() => setTab('banks')}
          >
            <Trans>Banks</Trans>
          </Button>
        </View>
      )}

      <Search
        value={search}
        onChange={setSearch}
        placeholder={tab === 'banks' ? t('Search banks') : t('Search icons')}
        width="100%"
        isInModal
      />

      {tab === 'icons' ? (
        <TablerGrid
          // Remount on search so the scroll position resets with the results.
          key={search}
          query={search}
          selected={parsed?.set === 'tabler' ? parsed.name : undefined}
          onSelect={name =>
            commit({ icon: makeIcon('tabler', name), color: value.color })
          }
        />
      ) : (
        <BankGrid
          query={search}
          selected={parsed?.set === 'bank' ? parsed.name : undefined}
          onSelect={bank =>
            commit({ icon: makeIcon('bank', bank.slug), color: bank.color })
          }
        />
      )}

      <ColorRow
        color={value.color}
        onChange={color => commit({ icon: value.icon, color })}
      />
    </View>
  );
}

function TablerGrid({
  query,
  selected,
  onSelect,
}: {
  query: string;
  selected?: string;
  onSelect: (name: string) => void;
}) {
  const tabler = useTablerIcons();
  const [scrollTop, setScrollTop] = useState(0);

  const names = useMemo(() => {
    if (!tabler) {
      return [];
    }
    const terms = query
      .toLowerCase()
      .split(/[\s-]+/)
      .filter(Boolean);
    if (terms.length === 0) {
      return tabler.names;
    }
    // Best matches first: exact name, name prefix, whole-word match, then any
    // substring. `names` is alphabetical and the sort is stable, so ties stay
    // in alphabetical order.
    const joined = terms.join('-');
    const rank = (name: string) => {
      if (name === joined) return 0;
      if (name.startsWith(joined)) return 1;
      const words = name.split('-');
      return terms.every(term => words.includes(term)) ? 2 : 3;
    };
    return tabler.names
      .filter(name => terms.every(term => name.includes(term)))
      .sort((a, b) => rank(a) - rank(b));
  }, [tabler, query]);

  if (!tabler) {
    return (
      <View style={{ height: GRID_HEIGHT, justifyContent: 'center' }}>
        <Text style={{ textAlign: 'center', color: theme.pageTextSubdued }}>
          <Trans>Loading icons…</Trans>
        </Text>
      </View>
    );
  }

  if (names.length === 0) {
    return (
      <View style={{ height: GRID_HEIGHT, justifyContent: 'center' }}>
        <Text style={{ textAlign: 'center', color: theme.pageTextSubdued }}>
          <Trans>No icons found</Trans>
        </Text>
      </View>
    );
  }

  const rowCount = Math.ceil(names.length / COLUMNS);
  const firstRow = Math.max(
    0,
    Math.floor(scrollTop / CELL_SIZE) - OVERSCAN_ROWS,
  );
  const lastRow = Math.min(
    rowCount - 1,
    Math.ceil((scrollTop + GRID_HEIGHT) / CELL_SIZE) + OVERSCAN_ROWS,
  );

  const cells = [];
  for (let row = firstRow; row <= lastRow; row++) {
    for (let col = 0; col < COLUMNS; col++) {
      const name = names[row * COLUMNS + col];
      if (!name) {
        break;
      }
      const body = tabler.getBody(name);
      cells.push(
        <button
          key={name}
          type="button"
          title={name}
          aria-label={name}
          aria-pressed={name === selected}
          onClick={() => onSelect(name)}
          style={{
            ...cellStyle,
            position: 'absolute',
            top: row * CELL_SIZE,
            left: col * CELL_SIZE,
            ...(name === selected && selectedCellStyle),
          }}
        >
          {body && (
            <svg
              viewBox="0 0 24 24"
              width={20}
              height={20}
              // The body comes from the bundled Tabler icon set.
              dangerouslySetInnerHTML={{ __html: body }}
            />
          )}
        </button>,
      );
    }
  }

  return (
    <div
      data-testid="icon-picker-grid"
      onScroll={e => setScrollTop(e.currentTarget.scrollTop)}
      style={{
        height: GRID_HEIGHT,
        overflowY: 'auto',
        overflowX: 'hidden',
        position: 'relative',
      }}
    >
      <div style={{ height: rowCount * CELL_SIZE, position: 'relative' }}>
        {cells}
      </div>
    </div>
  );
}

function BankGrid({
  query,
  selected,
  onSelect,
}: {
  query: string;
  selected?: string;
  onSelect: (bank: (typeof BANKS)[number]) => void;
}) {
  const { t } = useTranslation();
  const banks = BANKS.filter(
    bank =>
      bank.name.toLowerCase().includes(query.toLowerCase()) ||
      bank.slug.includes(query.toLowerCase()),
  );

  return (
    <View
      data-testid="bank-picker-grid"
      style={{
        height: GRID_HEIGHT,
        overflowY: 'auto',
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignContent: 'flex-start',
      }}
    >
      {banks.length === 0 && (
        <Text style={{ color: theme.pageTextSubdued, padding: 10 }}>
          <Trans>No banks found</Trans>
        </Text>
      )}
      {banks.map(bank => (
        <button
          key={bank.slug}
          type="button"
          title={bank.slug === 'generic' ? t('Generic bank') : bank.name}
          aria-label={bank.slug === 'generic' ? t('Generic bank') : bank.name}
          aria-pressed={bank.slug === selected}
          onClick={() => onSelect(bank)}
          style={{
            ...cellStyle,
            width: CELL_SIZE * 2,
            ...(bank.slug === selected && selectedCellStyle),
          }}
        >
          {getBankLogoUrl(bank.slug) && (
            <EntityIcon icon={makeIcon('bank', bank.slug)} size={26} />
          )}
        </button>
      ))}
    </View>
  );
}

function ColorRow({
  color,
  onChange,
}: {
  color: string | null;
  onChange: (color: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <View
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 6,
      }}
      data-testid="icon-picker-colors"
    >
      {ICON_COLOR_PRESETS.map(preset => (
        <button
          key={preset}
          type="button"
          aria-label={preset}
          aria-pressed={preset === color}
          onClick={() => onChange(preset)}
          style={{
            width: 18,
            height: 18,
            borderRadius: 9,
            padding: 0,
            cursor: 'pointer',
            backgroundColor: preset,
            border:
              preset === color
                ? `2px solid ${theme.pageText}`
                : `1px solid ${theme.tableBorder}`,
          }}
        />
      ))}
      <label
        title={t('Custom color')}
        style={{ display: 'flex', alignItems: 'center' }}
      >
        <input
          type="color"
          aria-label={t('Custom color')}
          value={isValidHexColor(color) ? color! : '#6366f1'}
          onChange={e => onChange(e.target.value)}
          style={{ width: 24, height: 22, padding: 0, border: 0 }}
        />
      </label>
    </View>
  );
}

const cellStyle = {
  width: CELL_SIZE,
  height: CELL_SIZE,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'transparent',
  border: '1px solid transparent',
  borderRadius: 6,
  cursor: 'pointer',
  color: 'inherit',
  padding: 0,
} as const;

const selectedCellStyle = {
  backgroundColor: theme.menuItemBackgroundHover,
  border: `1px solid ${theme.buttonPrimaryBackground}`,
} as const;

type IconPickerPopoverProps = IconPickerProps & {
  triggerRef: RefObject<HTMLElement | null>;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
};

/** The picker anchored to an element, e.g. a sidebar row. */
export function IconPickerPopover({
  triggerRef,
  isOpen,
  onOpenChange,
  ...pickerProps
}: IconPickerPopoverProps) {
  return (
    <Popover
      triggerRef={triggerRef}
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      placement="bottom start"
      style={{ backgroundColor: theme.menuBackground }}
    >
      <IconPicker {...pickerProps} />
    </Popover>
  );
}
