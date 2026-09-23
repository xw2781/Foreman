import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: { '@shared': path.resolve(root, 'src/shared') }
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node'
  }
});
