import { defineConfig } from 'vite';

// GitHub Pages compatibility: all paths are relative, WASM is bundled as a static asset.
export default defineConfig({
  base: './',
  optimizeDeps: {
    exclude: ['manifold-3d']
  },
  worker: {
    format: 'es'
  },
  build: {
    target: 'esnext'
  }
});
