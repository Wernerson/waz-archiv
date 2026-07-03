import { createReadStream, statSync } from 'fs'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const PAGES_JSON = new URL('../pages.json', import.meta.url).pathname

function serveFile(res: import('http').ServerResponse, file: string, contentType: string): boolean {
  try {
    const stat = statSync(file)
    if (stat.isFile()) {
      res.setHeader('Content-Type', contentType)
      res.setHeader('Content-Length', stat.size)
      createReadStream(file).pipe(res as NodeJS.WritableStream)
      return true
    }
  } catch {
    // not found — fall through
  }
  return false
}

export default defineConfig({
  plugins: [
    react(),
    {
      // Serve the extracted pages.json from the repo root in dev.
      // In production Nginx serves /pages.json.
      name: 'serve-archive-data',
      configureServer(server) {
        server.middlewares.use('/pages.json', (_req, res, next) => {
          if (!serveFile(res, PAGES_JSON, 'application/json')) next()
        })
      },
    },
  ],
  server: {
    proxy: {
      // PDFs stay on waz-zh.ch (no CORS there, so same-origin proxy).
      // In production Nginx proxy_passes /Portals/ to https://www.waz-zh.ch.
      '/Portals': {
        target: 'https://www.waz-zh.ch',
        changeOrigin: true,
      },
    },
  },
})
