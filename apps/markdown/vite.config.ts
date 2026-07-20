import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  server: { port: 8082 },
  define: { global: 'globalThis' },
  resolve: {
    alias: {
      'simple-peer': path.resolve(__dirname, 'vendor/simple-peer.js'),
    },
  },
  optimizeDeps: {
    exclude: ['simple-peer'],
  },
});