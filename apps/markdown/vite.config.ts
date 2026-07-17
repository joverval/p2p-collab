import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  plugins: [nodePolyfills()],
  server: { port: 8082 },
  define: {
    global: 'globalThis',
  },
});