import { defineConfig } from 'vite';
export default defineConfig({ server: { watch: { ignored: ['**/.local', '**/.local/**'] } }, build: { outDir: 'dist/client' } });
