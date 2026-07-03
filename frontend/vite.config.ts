import { createReadStream, statSync } from 'fs'
import { join } from 'path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const PDF_DIR = new URL('../pdfs', import.meta.url).pathname
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
      // Serve PDFs and the extracted pages.json from the repo root in dev.
      // In production Nginx handles /pdfs/* and /pages.json.
      name: 'serve-archive-data',
      configureServer(server) {
        server.middlewares.use('/pdfs', (req, res, next) => {
          const file = join(PDF_DIR, decodeURIComponent(req.url ?? ''))
          if (!serveFile(res, file, 'application/pdf')) next()
        })
        server.middlewares.use('/pages.json', (_req, res, next) => {
          if (!serveFile(res, PAGES_JSON, 'application/json')) next()
        })
      },
    },
  ],
})
