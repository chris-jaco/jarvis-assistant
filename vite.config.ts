import { defineConfig } from 'vite';
export default defineConfig({
  // The Chrome extension has its own build; only Atlas HTML belongs to this dev scan.
  optimizeDeps: { entries: ['index.html'] },
  server: { watch: { ignored: ['**/.local', '**/.local/**', '**/extension', '**/extension/**'] } },
  build: { outDir: 'dist/client' }
});
