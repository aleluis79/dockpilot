import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(), 
    tailwindcss()
  ],
  server: {
    // Se fija a proposito: antes se heredaba el default de Vite (5173), que
    // ademas colisiona con cualquier otro proyecto Vite abierto.
    port: 8182,
    // Sin esto Vite se mueve al puerto siguiente si encuentra el ocupado y la
    // app acaba sirviéndose en una URL que nadie ha documentado, sin avisar.
    // Con strictPort falla, que es justo lo que se quiere saber.
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8181',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://127.0.0.1:8181',
        ws: true,
      },
    },
  },
})
