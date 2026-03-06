import express from 'express'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()

// Configuration
const PORT = process.env.PORT || 5173
const INTERNAL_BACKEND_URL = process.env.INTERNAL_BACKEND_URL
const FALLBACK_BACKEND_URLS = [
  // Railway often sets backend PORT to 8080 in production; keep 4000 as legacy default.
  'http://idpa-backend.railway.internal:8080',
  'http://idpa_backend.railway.internal:8080',
  'http://idpa-backend.railway.internal:4000',
  'http://idpa_backend.railway.internal:4000',
]

// Security / framing for widget — allow embedding from any domain
app.use((req, res, next) => {
  res.removeHeader('X-Frame-Options')
  res.setHeader('Content-Security-Policy', "frame-ancestors *;")
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
  next()
})

// Basic JSON parsing for API proxy
app.use('/api', express.json({ limit: '1mb' }))
app.use('/api', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*')
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept')
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  if (req.method === 'OPTIONS') return res.sendStatus(200)
  return next()
})

// Very small proxy for /api/* to internal backend URL
app.use('/api', async (req, res) => {
  const startTime = Date.now()
  console.log(`[PROXY] ${req.method} ${req.originalUrl} - Starting...`)

  try {
    const baseUrls = Array.from(
      new Set([...(INTERNAL_BACKEND_URL ? [INTERNAL_BACKEND_URL] : []), ...FALLBACK_BACKEND_URLS]),
    )
    const errors = []

    const headers = { ...req.headers }
    // Remove hop-by-hop headers
    delete headers['host']
    delete headers['content-length']

    // Only abort on client disconnect for streaming requests (GET, SSE)
    // For mutations (POST, PUT, PATCH, DELETE), let them complete even if client disconnects
    const abortController = new AbortController()
    const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)
    if (!isMutation) {
      req.on('close', () => abortController.abort())
    }

    const init = {
      method: req.method,
      headers,
      redirect: 'manual',
      signal: isMutation ? undefined : abortController.signal,
    }

    if (!['GET', 'HEAD'].includes(req.method)) {
      // If body was parsed by express.json, forward JSON; otherwise raw is not handled here
      if (req.is('application/json') && req.body !== undefined) {
        init.body = JSON.stringify(req.body)
      } else {
        // Fallback: read raw body
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        init.body = Buffer.concat(chunks)
      }
    }

    for (const baseUrl of baseUrls) {
      const targetUrl = baseUrl + req.originalUrl
      try {
        console.log(`[PROXY] Trying ${targetUrl}...`)
        const response = await fetch(targetUrl, init)
        console.log(`[PROXY] ${req.method} ${req.originalUrl} -> ${response.status} (${Date.now() - startTime}ms)`)
        // Forward status and headers (strip restrictive security headers from backend)
        const stripHeaders = new Set([
          'transfer-encoding',
          'x-frame-options',
          'content-security-policy',
          'cross-origin-opener-policy',
          'cross-origin-resource-policy',
          'cross-origin-embedder-policy',
        ])
        res.status(response.status)
        response.headers.forEach((value, key) => {
          if (stripHeaders.has(key.toLowerCase())) return
          res.setHeader(key, value)
        })

        const contentType = response.headers.get('content-type') || ''
        if (contentType.includes('text/event-stream') && response.body) {
          res.flushHeaders?.()
          const stream = Readable.fromWeb(response.body)
          pipeline(stream, res).catch(() => {
            // ignore disconnects / aborted streams
          })
          return
        }

        const buffer = Buffer.from(await response.arrayBuffer())
        return res.send(buffer)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.log(`[PROXY] Failed ${targetUrl}: ${msg}`)
        errors.push(`${baseUrl}: ${msg}`)
      }
    }

    console.error(`[PROXY] ${req.method} ${req.originalUrl} -> 502 ALL BACKENDS FAILED (${Date.now() - startTime}ms)`, errors)
    res.status(502).json({
      error: 'Proxy-Fehler: Backend nicht erreichbar',
      details: errors,
      hint: 'Setze INTERNAL_BACKEND_URL auf http://<backend-service-name>.railway.internal:4000',
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Proxy-Fehler'
    res.status(502).json({ error: msg })
  }
})

// Serve static files from dist
const distDir = path.resolve(__dirname, '..', 'dist')
app.use(express.static(distDir, { index: false }))

// SPA fallback for all non-API GET requests
app.use((req, res, next) => {
  if (req.method !== 'GET') return next()
  if (req.path.startsWith('/api')) return next()
  res.sendFile(path.join(distDir, 'index.html'))
})

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  const baseUrls = INTERNAL_BACKEND_URL ? [INTERNAL_BACKEND_URL] : FALLBACK_BACKEND_URLS
  console.log(`Frontend server listening on :${PORT} (proxy -> ${baseUrls.join(' | ')})`)
})
