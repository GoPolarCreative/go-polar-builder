import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { cloudflare } from '@cloudflare/vite-plugin'

// One process for the whole app: Vite serves the React client, the Cloudflare plugin runs
// worker/index.ts inside workerd with real local D1 and R2 bindings. `npm run dev` is all of it.
export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
  server: { port: 5173 },
  build: { sourcemap: true },
})
