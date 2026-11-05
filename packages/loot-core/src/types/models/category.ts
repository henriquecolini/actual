import type { CategoryGroupEntity } from './category-group';

export type CategoryEntity = {
  id: string;
  name: string;
  is_income?: boolean;
  group: CategoryGroupEntity['id'];
  goal_def?: string;
  cleanup_def?: string;
  template_settings?: { source: 'notes' | 'ui' };
  sort_order?: number;
  tombstone?: boolean;
  hidden?: boolean;
  icon?: string | null; // "<set>:<name>", e.g. "tabler:shopping-cart"
  icon_color?: string | null; // hex background color
};
