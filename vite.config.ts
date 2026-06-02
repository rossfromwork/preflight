import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve(__dirname, 'src/web'),
  plugins: [react()],
  // Absolute base so the SPA loads correctly when the user navigates
  // directly to a non-root URL like /sessions or /history. The static
  // handler serves index.html for any extensionless path; with base:'./',
  // the served HTML's relative asset paths would resolve against the
  // current URL ('./assets/x.js' under '/sessions/' becomes
  // '/sessions/assets/x.js' — a 404). Absolute paths always resolve from
  // the origin.
  base: '/',
  build: {
    outDir: resolve(__dirname, 'dist/web'),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:7777',
      '/sse': { target: 'http://127.0.0.1:7777', changeOrigin: false, ws: false },
    },
  },
});
