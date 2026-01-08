import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  base: '/projects/all-in/',
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        tsla: resolve(__dirname, 'tsla.html'),
        earnings: resolve(__dirname, 'earnings.html'),
      },
    },
  },
});
