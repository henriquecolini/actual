// @ts-strict-ignore
import React, { useRef, useState } from 'react';
import type { CSSProperties, Ref } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { SvgCheveronDown } from '@actual-app/components/icons/v1';
import { TextOneLine } from '@actual-app/components/text-one-line';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import type {
  CategoryEntity,
  CategoryGroupEntity,
} from '@actual-app/core/types/models';

import { EntityIcon } from '#components/common/EntityIcon/EntityIcon';
import { IconPickerPopover } from '#components/common/EntityIcon/IconPicker';
import { InputCell } from '#components/table';
import { useContextMenu } from '#hooks/useContextMenu';
import { useGlobalPref } from '#hooks/useGlobalPref';

import { SidebarCategoryButtons } from './SidebarCategoryButtons';

const ICON_SIZE = 16;
const ICON_GAP = 3;

type SidebarCategoryProps = {
  innerRef: Ref<HTMLDivElement>;
  category: CategoryEntity;
  categoryGroup?: CategoryGroupEntity;
  dragPreview?: boolean;
  dragging?: boolean;
  goalsShown?: boolean;
  style?: CSSProperties;
  borderColor?: string;
  isLast?: boolean;
  onEditName: (id: CategoryEntity['id']) => void;
  onSave: (category: CategoryEntity) => void;
  onHideNewCategory?: () => void;
} & (
  | {
      editing: true;
      onDelete?: never;
    }
  | {
      editing: boolean;
      onDelete: (id: CategoryEntity['id']) => void;
    }
);

export function SidebarCategory({
  innerRef,
  category,
  categoryGroup,
  dragPreview,
  dragging,
  editing,
  goalsShown = false,
  style,
  isLast,
  onEditName,
  onSave,
  onDelete,
  onHideNewCategory,
}: SidebarCategoryProps) {
  const { t } = useTranslation();
  const [categoryExpandedStatePref] = useGlobalPref('categoryExpandedState');
  const categoryExpandedState = categoryExpandedStatePref ?? 0;

  const temporary = category.id === 'new';
  const triggerRef = useRef(null);
  // Stays mounted in both display and rename mode, unlike `triggerRef`.
  const iconAnchorRef = useRef(null);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const hasIcon = !temporary && !!category.icon;
  const { handleContextMenu } = useContextMenu({
    triggerRef,
    items: [
      {
        name: 'rename',
        text: t('Rename'),
        onClick: () => onEditName(category.id),
      },
      !temporary && {
        name: 'change-icon',
        text: t('Change icon'),
        onClick: () => setIconPickerOpen(true),
      },
      !categoryGroup?.hidden && {
        name: 'toggle-visibility',
        text: category.hidden ? t('Show') : t('Hide'),
        onClick: () => onSave({ ...category, hidden: !category.hidden }),
      },
      {
        name: 'delete',
        text: t('Delete'),
        onClick: () => onDelete(category.id),
      },
    ],
  });

  const displayed = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        opacity: category.hidden || categoryGroup?.hidden ? 0.33 : undefined,
        backgroundColor: 'transparent',
        height: 20,
      }}
      ref={triggerRef}
    >
      <TextOneLine data-testid="category-name">{category.name}</TextOneLine>
      <View style={{ flexShrink: 0, marginLeft: 5 }}>
        <Button
          variant="bare"
          className="hover-visible"
          style={{ color: 'currentColor', padding: 3 }}
          onPress={handleContextMenu}
        >
          <SvgCheveronDown
            width={14}
            height={14}
            style={{ color: 'currentColor' }}
          />
        </Button>
      </View>
      <SidebarCategoryButtons
        category={category}
        dragging={dragging}
        goalsShown={goalsShown}
      />
    </View>
  );

  return (
    <>
      <View
        innerRef={innerRef}
        style={{
          width: 200 + 100 * categoryExpandedState,
          position: 'relative',
          overflow: 'hidden',
          '& .hover-visible': {
            display: 'none',
          },
          ...(!dragging &&
            !dragPreview && {
              '&:hover .hover-visible': {
                display: 'flex',
              },
            }),
          ...(dragging && { color: theme.pageTextSubdued }), //always visible color
          // The zIndex here forces the the view on top of a row below
          // it that may be "collapsed" and show a border on top
          ...(dragPreview && {
            backgroundColor: theme.budgetCurrentMonth,
            zIndex: 10000,
            borderRadius: 6,
            overflow: 'hidden',
          }),
          ...style,
        }}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            onEditName(null);
            e.stopPropagation();
          }
        }}
      >
        <InputCell
          value={category.name}
          formatter={() => displayed}
          width="flex"
          exposed={editing || temporary}
          onUpdate={value => {
            if (temporary) {
              if (value === '') {
                onHideNewCategory();
              } else if (value !== '') {
                onSave({ ...category, name: value });
              }
            } else {
              if (value !== category.name) {
                onSave({ ...category, name: value });
              }
            }
          }}
          onBlur={() => onEditName(null)}
          style={{
            // Reserve room for the icon in display *and* rename mode so the text
            // doesn't jump when editing starts.
            paddingLeft: hasIcon ? 13 + ICON_SIZE + ICON_GAP : 13,
            ...(isLast && { borderBottomWidth: 0 }),
          }}
          inputProps={{
            placeholder: temporary ? t('New category name') : '',
          }}
        />
        {!temporary && (
          <View
            innerRef={iconAnchorRef}
            style={{
              position: 'absolute',
              left: 13,
              top: 0,
              bottom: 0,
              justifyContent: 'center',
              opacity:
                category.hidden || categoryGroup?.hidden ? 0.33 : undefined,
            }}
          >
            {hasIcon && (
              <Button
                variant="bare"
                aria-label={t('Change icon')}
                style={{ padding: 0, borderRadius: 4 }}
                onPress={() => setIconPickerOpen(true)}
              >
                <EntityIcon
                  icon={category.icon}
                  color={category.icon_color}
                  size={ICON_SIZE}
                />
              </Button>
            )}
          </View>
        )}
      </View>
      {iconPickerOpen && (
        <IconPickerPopover
          triggerRef={iconAnchorRef}
          isOpen={iconPickerOpen}
          onOpenChange={setIconPickerOpen}
          value={{
            icon: category.icon ?? null,
            color: category.icon_color ?? null,
          }}
          onChange={({ icon, color }) =>
            onSave({ ...category, icon, icon_color: color })
          }
        />
      )}
    </>
  );
}
