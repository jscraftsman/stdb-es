import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Keep this suite scoped to the example's integration directory even when
  // the root package script invokes Vitest from the repository root.
  root: path.dirname(fileURLToPath(import.meta.url)),
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    // Each run publishes a module to a disposable in-memory database.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
