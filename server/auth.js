// Login: an Emby administrator account (checked live against Emby), or the local ADMIN_USER / ADMIN_PASSWORD.
// Sessions are random ids in SQLite, sent as an HttpOnly cookie.

import crypto from 'node:crypto'
import { config } from './config.js'
import { run, get } from './db.js'
import { emby, embyConfigured } from './emby.js'

export const COOKIE = 'egm_session'

function safeEqual(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

export function loginMethods() {
  return { emby: embyConfigured(), password: Boolean(config.adminPassword) }
}

export async function login(username, password) {
  username = String(username || '').trim()
  if (!username || !password) return { ok: false, error: 'Benutzername und Passwort angeben' }

  if (config.adminPassword && username.toLowerCase() === config.adminUser.toLowerCase() && safeEqual(password, config.adminPassword)) {
    return { ok: true, session: createSession(config.adminUser, null) }
  }
  if (embyConfigured()) {
    let auth
    try {
      auth = await emby.authenticate(username, password)
    } catch (e) {
      if (e.status && e.status < 500) return { ok: false, error: 'Anmeldung fehlgeschlagen' }
      return { ok: false, error: e.message }
    }
    // We only needed the check; end the Emby session again so it does not pile up under Devices.
    if (auth?.AccessToken) await emby.logout(auth.AccessToken)
    if (!auth?.User?.Policy?.IsAdministrator) return { ok: false, error: 'Nur Emby-Administratoren dürfen sich anmelden' }
    return { ok: true, session: createSession(auth.User.Name, auth.User.Id) }
  }
  return { ok: false, error: 'Anmeldung fehlgeschlagen' }
}

function createSession(username, embyUserId) {
  const id = crypto.randomBytes(32).toString('hex')
  const t = Date.now()
  run('INSERT INTO sessions (id, username, emby_user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', id, username, embyUserId, t, t + config.sessionDays * 86400000)
  run('DELETE FROM sessions WHERE expires_at < ?', t)
  return { id, username }
}

export function sessionFromCookie(id) {
  if (!id) return null
  const s = get('SELECT * FROM sessions WHERE id = ?', id)
  if (!s || s.expires_at < Date.now()) return null
  return s
}

export function logout(id) {
  if (id) run('DELETE FROM sessions WHERE id = ?', id)
}

export function cookieHeader(id, maxAgeSeconds) {
  const parts = [`${COOKIE}=${id}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`]
  if (config.secureCookies) parts.push('Secure')
  return parts.join('; ')
}
