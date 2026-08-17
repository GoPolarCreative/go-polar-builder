import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Client build only. The API is a Hono app that runs as a Vercel Node function in production
 * (api/index.ts) and behind @hono/node-server locally (server/local.ts).
 *
 * `npm run dev` runs both with concurrently, and this proxies /api at the local API server, so
 * the browser sees one origin exactly as it will on Vercel.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.API_ORIGIN ?? 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
})
