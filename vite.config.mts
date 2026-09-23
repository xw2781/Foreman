import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

// React Fast Refresh injects an inline module script in dev; production keeps the strict policy.
const devCsp = {
  name: 'dev-csp',
  apply: 'serve' as const,
  transformIndexHtml: (html: string) => html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
};

export default defineConfig({
  root: path.resolve(root, 'src/renderer'),
  base: './',
  plugins: [react(), devCsp],
  resolve: {
    alias: { '@shared': path.resolve(root, 'src/shared') }
  },
  build: {
    outDir: path.resolve(root, 'out/renderer'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000
  },
  server: { port: 5199, strictPort: false }
});
