import { createReadStream, statSync } from 'fs'
import { join } from 'path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const PDF_DIR = new URL('../pdfs', import.meta.url).pathname

export default defineConfig({
  plugins: [
    react(),
    {
      // Serve PDFs from the local pdfs/ directory in dev.
      // In production Nginx handles /pdfs/*.
      name: 'serve-pdfs',
      configureServer(server) {
        server.middlewares.use('/pdfs', (req, res, next) => {
          const file = join(PDF_DIR, decodeURIComponent(req.url ?? ''))
          try {
            const stat = statSync(file)
            if (stat.isFile()) {
              res.setHeader('Content-Type', 'application/pdf')
              res.setHeader('Content-Length', stat.size)
              createReadStream(file).pipe(res as NodeJS.WritableStream)
              return
            }
          } catch {
            // not found — fall through
          }
          next()
        })
      },
    },
  ],
  server: {
    proxy: {
      '/opensearch': {
        target: 'http://localhost:9200',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/opensearch/, ''),
      },
    },
  },
})
