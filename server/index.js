import http from 'node:http'
import { config } from './config.js'
import { readJson, sendJson, serveStatic, parseCookies, HttpError } from './http.js'
import { COOKIE, login, logout, sessionFromCookie, cookieHeader, loginMethods } from './auth.js'
import { api } from './api.js'
import { startScheduler } from './sync.js'
import { embyConfigured } from './emby.js'

const failedLogins = new Map() // ip -> { count, until }

async function handleAuth(req, res, pathname) {
  const cookies = parseCookies(req.headers.cookie)
  if (pathname === '/api/auth/me' && req.method === 'GET') {
    const s = sessionFromCookie(cookies[COOKIE])
    return sendJson(res, 200, { user: s ? { name: s.username } : null, methods: loginMethods() })
  }
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const ip = req.socket.remoteAddress
    const f = failedLogins.get(ip)
    if (f && f.until > Date.now()) return sendJson(res, 429, { error: 'Zu viele Fehlversuche, bitte kurz warten' })
    const body = await readJson(req)
    const r = await login(body.username, body.password)
    if (!r.ok) {
      const count = (f?.count || 0) + 1
      failedLogins.set(ip, { count, until: count >= 5 ? Date.now() + 60000 : 0 })
      return sendJson(res, 401, { error: r.error })
    }
    failedLogins.delete(ip)
    return sendJson(res, 200, { user: { name: r.session.username } }, { 'Set-Cookie': cookieHeader(r.session.id, config.sessionDays * 86400) })
  }
  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    logout(cookies[COOKIE])
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader('', 0) })
  }
  return false
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const pathname = url.pathname
  try {
    if (pathname === '/health') return sendJson(res, 200, { ok: true })
    if (!pathname.startsWith('/api/')) {
      if (serveStatic(req, res, pathname)) return
      return sendJson(res, 404, { error: 'Nicht gefunden' })
    }
    if (pathname.startsWith('/api/auth/')) {
      if ((await handleAuth(req, res, pathname)) !== false) return
      return sendJson(res, 404, { error: 'Nicht gefunden' })
    }
    const session = sessionFromCookie(parseCookies(req.headers.cookie)[COOKIE])
    if (!session) return sendJson(res, 401, { error: 'Nicht angemeldet' })
    // Cross-site forms cannot set custom headers, so this plus SameSite=Lax keeps writes same-origin.
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'egm') return sendJson(res, 403, { error: 'Fehlender Header' })
    const route = api.match(req.method, pathname)
    if (!route) return sendJson(res, 404, { error: 'Nicht gefunden' })
    const body = req.method === 'GET' ? {} : await readJson(req)
    const result = await route.handler({ req, params: route.params, query: Object.fromEntries(url.searchParams), body, session })
    return sendJson(res, 200, result ?? { ok: true })
  } catch (e) {
    const status = e instanceof HttpError ? e.status : e.status && e.status >= 400 && e.status < 600 ? (e.status === 401 ? 502 : e.status) : 500
    if (status >= 500) console.error(`[${req.method} ${pathname}]`, e)
    if (!res.headersSent) sendJson(res, status, { error: e.message || 'Interner Fehler' })
  }
})

server.listen(config.port, () => {
  console.log(`Emby Group Manager läuft auf Port ${config.port} (Daten: ${config.dataDir})`)
  if (!embyConfigured()) console.warn('EMBY_URL / EMBY_API_KEY fehlen – nur die Oberfläche ist verfügbar.')
  if (!config.adminPassword && !embyConfigured()) console.warn('Weder ADMIN_PASSWORD noch Emby konfiguriert – Anmeldung nicht möglich.')
  startScheduler()
})

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)))
