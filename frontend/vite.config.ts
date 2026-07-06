import { createReadStream, statSync } from 'fs'
import { extname, join, normalize } from 'path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const REPO_ROOT = new URL('..', import.meta.url).pathname
const PAGES_JSON = join(REPO_ROOT, 'pages.json')
const PDF_DIR = join(REPO_ROOT, 'pdfs')
const COVER_DIR = join(REPO_ROOT, 'covers')

const CONTENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
}

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

// Serves files out of `base` for requests to the mount path, rejecting any
// path that would escape it (e.g. via "..").
function serveDir(base: string): import('connect').NextHandleFunction {
  return (req, res, next) => {
    const urlPath = decodeURIComponent((req.url ?? '').split('?')[0])
    const relative = normalize(urlPath).replace(/^[/\\]+/, '')
    const file = join(base, relative)
    if (relative.includes('..') || !file.startsWith(base)) {
      next()
      return
    }
    const contentType = CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
    if (!serveFile(res, file, contentType)) next()
  }
}

export default defineConfig({
  plugins: [
    react(),
    {
      // Serve the extracted archive data/assets from the repo root in dev.
      // In production Nginx serves /pages.json, /pdfs, and /covers the same way.
      name: 'serve-archive-data',
      configureServer(server) {
        server.middlewares.use('/pages.json', (_req, res, next) => {
          if (!serveFile(res, PAGES_JSON, 'application/json')) next()
        })
        server.middlewares.use('/pdfs', serveDir(PDF_DIR))
        server.middlewares.use('/covers', serveDir(COVER_DIR))
      },
    },
  ],
})
