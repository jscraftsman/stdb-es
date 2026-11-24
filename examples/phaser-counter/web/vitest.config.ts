import { defineConfig, type Plugin } from 'vitest/config';
import { spacetimedbModuleTestPlugin } from 'spacetimedb/server/test-utils/vitest';

export default defineConfig({
  // Client tests import `stdb-es/testing`; its barrel also exports the module
  // harness, so the plugin keeps that import graph resolvable in Node.
  plugins: [spacetimedbModuleTestPlugin() as unknown as Plugin],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
