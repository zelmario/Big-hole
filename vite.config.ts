import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { target: 'es2022' },
  worker: { format: 'es' },
  server: {
    // OPFS and cross-origin isolation aside, nothing here talks to the network; the app is
    // fully functional offline once loaded.
    port: 5173,
  },
});
