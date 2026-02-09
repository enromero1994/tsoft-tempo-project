import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // ESTA ES LA LÍNEA MÁGICA:
    allowedHosts: true,

    proxy: {
      '/api-tempo': {
        target: 'https://api.tempo.io/4',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api-tempo/, ''),
      },
      '/api-jira': {
        target: 'https://ayudatsoft.atlassian.net',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api-jira/, ''),
      },
    },
  },
});