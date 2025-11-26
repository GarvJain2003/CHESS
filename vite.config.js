import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('firebase')) return 'vendor-firebase';
            if (id.includes('react-chessboard') || id.includes('chess.js')) return 'vendor-chess';
            if (id.includes('tone')) return 'vendor-audio';
            return 'vendor';
          }
        },
      },
    },
  },
})
