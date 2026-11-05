import fs from 'node:fs';

import { vi } from 'vitest';

// Tests run against the real, built API (a real budget file, real AQL), like a
// production install. Resolving the package by name would pick its
// "development" export (TypeScript source that needs extra path mocks), so load
// the built bundle by path. Run `yarn build:api` first.
vi.mock('@actual-app/api', async () => {
  const distUrl = new URL('../../api/dist/index.js', import.meta.url);
  // `tsgo -b` (typecheck) overwrites dist/ with plain tsc output, so check it is the bundle.
  if (
    !fs.existsSync(distUrl) ||
    fs.readFileSync(distUrl, 'utf8').includes('./validateNodeVersion')
  ) {
    throw new Error(
      'The built API is missing or stale. Run `yarn workspace @actual-app/api build` first.',
    );
  }
  return await import(/* @vite-ignore */ distUrl.href);
});
