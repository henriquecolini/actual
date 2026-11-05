import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Load the built API natively (like a real install), not as source.
    server: { deps: { external: [/packages\/api\/dist/] } },
    setupFiles: ['./src/test-setup.ts'],
    globals: true,
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
