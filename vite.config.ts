import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  build: { target: 'es2022' },
  worker: { format: 'es' },

  /**
   * react-draggable (via react-grid-layout) guards its dev warnings with
   * `process.env.NODE_ENV`. `process` does not exist in a browser, so the first drag threw
   * `ReferenceError: process is not defined` and the gesture died silently -- the cursor
   * changed, because that is pure CSS, and nothing moved.
   *
   * jsdom cannot catch this: Node has a real `process`, so the tests passed throughout.
   */
  define: {
    'process.env.NODE_ENV': JSON.stringify(mode),
  },
  optimizeDeps: {
    // Pre-bundle the CJS grid dependencies so esbuild rewrites process.env at that boundary
    // too, rather than leaving it to leak into the browser.
    include: ['react-grid-layout', 'react-grid-layout/legacy', 'react-resizable', 'react-draggable'],
  },

  server: {
    // Nothing here talks to the network; the app is fully functional offline once loaded.
    port: 5173,
  },
}));
