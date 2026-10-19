import { defineConfig } from 'vitest/config';
import { offlinePlugin } from './tools/offline-plugin';

export default defineConfig({
  base: './',
  plugins: [offlinePlugin()],
  worker: { format: 'es' },
  server: { proxy: { '/api': process.env.WORKER_ORIGIN ?? 'http://127.0.0.1:8787', '/__dev': process.env.WORKER_ORIGIN ?? 'http://127.0.0.1:8787' } },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1100,
    rollupOptions: { output: { manualChunks: { three: ['three'] } } },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
