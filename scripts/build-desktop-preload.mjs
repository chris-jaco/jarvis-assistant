import { build } from 'vite';
await build({
  configFile: false,
  base: './',
  root: 'src/desktop/credential-setup',
  build: {
    emptyOutDir: true,
    outDir: '../../../dist/desktop-credential-setup',
    rollupOptions: { input: 'src/desktop/credential-setup/index.html', output: { entryFileNames: 'renderer.js', assetFileNames: 'style[extname]' } },
    minify: false
  }
});
await build({
  configFile: false,
  build: {
    emptyOutDir: false,
    outDir: 'dist/desktop-credential-setup',
    lib: { entry: 'src/desktop/credential-setup-preload.ts', formats: ['cjs'], fileName: () => 'preload.cjs' },
    rollupOptions: { external: ['electron'] },
    minify: false
  }
});
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
