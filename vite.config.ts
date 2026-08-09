import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Peer deps, pinned to the versions in package.json. Rewritten to CDN URLs in
// the emitted dist bundle (see output.paths below) so dist/speck.js runs
// straight in a browser via <script type="module">, no bundler or import map
// required on the consuming side. examples/matching-game.js imports the same
// URLs directly, so the browser's module cache resolves both to one instance.
const CDN = {
  three: 'https://cdn.jsdelivr.net/npm/three@0.160.1/build/three.module.js',
  'three/examples/jsm/loaders/GLTFLoader.js':
    'https://cdn.jsdelivr.net/npm/three@0.160.1/examples/jsm/loaders/GLTFLoader.js',
  '@dimforge/rapier3d-compat':
    'https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.14.0/rapier.es.js',
};

// Library build: bundle only the engine. three and rapier are marked external
// so they are side-loaded by the host app, never bundled into the lib.
export default defineConfig({
  build: {
    // `tsc --emitDeclarationOnly` runs before this (see package.json build
    // script) and writes .d.ts files into dist/; don't let Vite's default
    // emptyOutDir wipe them out.
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'Speck',
      fileName: 'speck',
      formats: ['es'],
    },
    rollupOptions: {
      external: Object.keys(CDN),
      output: {
        paths: CDN,
      },
    },
  },
});
