import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: 'public',
  server: {
    port: 3000,
    open: true,
    host: true // Expose to local network to test on mobile devices easily
  },
  build: {
    assetsInlineLimit: 0, // Avoid inlining binary assets (GLB, FBX) as base64
    outDir: 'dist'
  }
});
