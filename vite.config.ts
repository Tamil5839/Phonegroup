import preact from '@preact/preset-vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';
import { opencvVendor, serviceWorker } from './build/plugins.ts';

// HTTPS=1 npm run dev  → self-signed https on the LAN, so phones may use the camera.
export default defineConfig({
  base: './',
  plugins: [preact(), opencvVendor(), serviceWorker(), ...(process.env.HTTPS ? [basicSsl()] : [])],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  server: { host: true },
  preview: { host: true },
});
