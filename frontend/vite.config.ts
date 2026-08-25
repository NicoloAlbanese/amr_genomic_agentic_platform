import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // No build-time `define` of AWS identifiers: the SPA loads /runtime-config.json
  // at startup (see src/config.ts), so the same bundle is account-agnostic.
  build: {
    // Warn if any chunk exceeds 500 kB (NFR-004)
    chunkSizeWarningLimit: 500,
    rollupOptions: {
      output: {
        // Vendor splitting for long-term caching (NFR-004)
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
          charts: ['recharts'],
          auth: ['aws-amplify'],
        },
      },
    },
  },
});
