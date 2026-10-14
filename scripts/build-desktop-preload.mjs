import { build } from 'vite';
await build({
  configFile: false,
  build: {
    emptyOutDir: true,
    outDir: 'dist/desktop-preload',
    lib: { entry: 'src/desktop/preload.ts', formats: ['cjs'], fileName: () => 'preload.cjs' },
    rollupOptions: { external: ['electron'] },
    minify: false
  }
});
