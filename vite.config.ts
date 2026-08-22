import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Bare specifiers: resolved via node_modules (bundlers) or an import map (script tags, see examples/*/*.html).
const PEER_DEPS = ['three', 'three/examples/jsm/loaders/GLTFLoader.js', '@dimforge/rapier3d-compat'];

export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      formats: ['es'],
    },
    rollupOptions: {
      external: PEER_DEPS,
      output: {
        preserveModules: true,
        preserveModulesRoot: 'src',
        entryFileNames: '[name].js',
      },
    },
  },
});
