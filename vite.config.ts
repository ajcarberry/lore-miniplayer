import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Browser-mode dev server only (`pnpm dev`, `pnpm test:play:codegen`).
// The app itself builds through electron-vite (electron.vite.config.ts).
export default defineConfig({
  plugins: [react()],
  publicDir: 'assets',
  base: './',
  server: {
    port: 5173,
    strictPort: true,
  },
});
