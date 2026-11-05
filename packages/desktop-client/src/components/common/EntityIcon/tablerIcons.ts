import { useEffect, useState } from 'react';

import type { IconifyJSON } from '@iconify-json/tabler';

// The Tabler set is ~2MB of JSON, so it is loaded as its own chunk the first
// time any Tabler icon is rendered (or the picker opens) and then shared.

type TablerSet = {
  names: string[];
  getBody: (name: string) => string | undefined;
};

let loaded: TablerSet | null = null;
let loading: Promise<TablerSet> | null = null;

function buildSet(data: IconifyJSON): TablerSet {
  const aliases = data.aliases ?? {};
  return {
    names: [...Object.keys(data.icons), ...Object.keys(aliases)].sort(),
    getBody(name) {
      const icon = data.icons[name] ?? data.icons[aliases[name]?.parent ?? ''];
      return icon?.body;
    },
  };
}

export function loadTablerIcons(): Promise<TablerSet> {
  if (loaded) {
    return Promise.resolve(loaded);
  }
  loading ??= import('@iconify-json/tabler').then(module => {
    loaded = buildSet(module.icons);
    return loaded;
  });
  return loading;
}

export function useTablerIcons(): TablerSet | null {
  const [set, setSet] = useState<TablerSet | null>(loaded);

  useEffect(() => {
    if (set) {
      return;
    }
    let cancelled = false;
    loadTablerIcons().then(
      result => {
        if (!cancelled) {
          setSet(result);
        }
      },
      () => {
        // Leave the icon unrendered; the fallback box stays visible.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [set]);

  return set;
}
