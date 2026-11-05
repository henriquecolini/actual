import path from 'path';

import { defineConfig } from 'vite';

export default defineConfig({
  // The API embeds loot-core and native modules, so it stays external, as does
  // the large icon set (loaded only when icons are searched).
  ssr: {
    noExternal: true,
    external: ['@actual-app/api', '@iconify-json/tabler'],
  },
  build: {
    ssr: true,
    target: 'node22',
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
    lib: {
      entry: path.resolve(__dirname, 'src/index.ts'),
      formats: ['es'],
    },
    rollupOptions: {
      output: {
        entryFileNames: 'mcp.js',
        banner: chunk => (chunk.isEntry ? '#!/usr/bin/env node' : ''),
      },
    },
  },
});
