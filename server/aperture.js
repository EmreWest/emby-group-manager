// Which Emby library belongs to which user's Aperture picks. Read-only towards Aperture: nothing here writes to its
// API or database. Methods, in this order (the first that names an owner wins, per library):
//   1. Aperture API   GET /api/users (provider_user_id = Emby user id) + GET /api/settings/strm-libraries
//   2. Aperture DB    strm_libraries JOIN users, read-only transaction
//   3. Folder path    Aperture writes to <prefix>/aperture/<Name>_<EmbyUserId> (movies) and /aperture-tv/ (series)
//   4. Name pattern   e.g. "Für dich ausgewählt {username} {type}", compared case-insensitively
// Checked against Aperture v0.7.10 (packages/core/src/strm/*/library.ts, apps/api/src/routes/...).

import { config } from './config.js'

export const TESTED_APERTURE_VERSION = '0.7.10'

const norm = (s) => String(s || '').toLowerCase().replace(/[-{}]/g, '')

async function apertureFetch(path) {
  const res = await fetch(config.apertureUrl + path, {
    headers: { Accept: 'application/json', 'X-API-Key': config.apertureApiKey },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`Aperture ${path}: HTTP ${res.status}`)
  return res.json()
}

export async function apertureVersion() {
  if (!config.apertureUrl) return null
  try {
    const r = await apertureFetch('/api/version')
    return r?.version || r?.current || JSON.stringify(r)
  } catch {
    return null
  }
}

// -> [{ embyUserId, libraryId, libraryGuid, name, mediaType }]
async function recordsFromApi() {
  const [{ users = [] }, { libraries = [] }] = await Promise.all([apertureFetch('/api/users'), apertureFetch('/api/settings/strm-libraries')])
  const byId = new Map(users.map((u) => [u.id, u]))
  return libraries
    .filter((l) => !l.channelId && l.isActive !== false)
    .map((l) => ({
      embyUserId: byId.get(l.userId)?.provider_user_id || null,
      apertureUser: byId.get(l.userId)?.username || l.userName || null,
      libraryId: l.providerLibraryId,
      libraryGuid: null,
      name: l.name,
      mediaType: l.mediaType === 'series' ? 'series' : 'movies',
    }))
}

async function recordsFromDb() {
  const { default: pg } = await import('pg')
  const client = new pg.Client({ connectionString: config.apertureDbUrl, statement_timeout: 10000, connectionTimeoutMillis: 10000 })
  await client.connect()
  try {
    await client.query('BEGIN TRANSACTION READ ONLY')
    // SELECT sl.* keeps this working across schema versions (media_type since 0037, provider_library_guid since 0020).
    const { rows } = await client.query(
      `SELECT sl.*, u.provider_user_id, u.username
         FROM strm_libraries sl LEFT JOIN users u ON u.id = sl.user_id
        WHERE sl.channel_id IS NULL`,
    )
    await client.query('ROLLBACK')
    return rows
      .filter((r) => r.is_active !== false && (r.library_type == null || r.library_type === 'ai-recs'))
      .map((r) => ({
        embyUserId: r.provider_user_id || null,
        apertureUser: r.username || null,
        libraryId: r.provider_library_id,
        libraryGuid: r.provider_library_guid || null,
        name: r.name,
        mediaType: r.media_type === 'series' ? 'series' : 'movies',
      }))
  } finally {
    await client.end().catch(() => {})
  }
}

const SEP = '[\\s\\-–—:|·_]+'
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function patternRegex(pattern, typeMovies, typeSeries) {
  let rx = '^\\s*'
  for (const part of String(pattern || '').split(/(\{username\}|\{type\})/)) {
    if (part === '{username}') rx += '(?<username>.+?)'
    else if (part === '{type}') rx += `(?<type>${esc(typeMovies)}|${esc(typeSeries)})`
    else rx += part.split(/[\s\-–—:|·_]+/).map((w, i, arr) => (w ? esc(w) : '') + (i < arr.length - 1 ? SEP : '')).join('')
  }
  return new RegExp(rx + '\\s*$', 'iu')
}

function pathOwnerKey(locations = []) {
  for (const loc of locations) {
    const m = /[\\/](aperture(-tv)?)[\\/]([^\\/]+?)[\\/]*$/i.exec(loc)
    if (m) {
      const folder = m[3]
      const idPart = folder.includes('_') ? folder.slice(folder.lastIndexOf('_') + 1) : folder
      return { key: norm(idPart), series: Boolean(m[2]) }
    }
  }
  return null
}

const typeFromCollection = (folder) => (folder.CollectionType === 'tvshows' ? 'series' : 'movies')

/**
 * @returns {{ libraries: Array<{guid, itemId, name, mediaType, ownerId, ownerName, method, problem}>,
 *            sources: { api: string, db: string }, version: string|null }}
 *  libraries lists only folders recognised as Aperture libraries; ownerId null means "found but not assignable".
 */
export async function resolveApertureLibraries(folders, users, settings) {
  const userById = new Map(users.map((u) => [norm(u.Id), u]))
  const userByName = new Map(users.map((u) => [String(u.Name).normalize('NFC').trim().toLowerCase(), u]))
  const folderIndex = new Map()
  for (const f of folders) {
    for (const k of [f.ItemId, f.Id, f.Guid]) if (k) folderIndex.set(norm(k), f)
  }
  const folderByName = new Map(folders.map((f) => [f.Name.toLowerCase(), f]))

  const sources = { api: 'nicht konfiguriert', db: 'nicht konfiguriert' }
  let records = null
  let recordMethod = null
  if (config.apertureUrl && config.apertureApiKey) {
    try {
      records = await recordsFromApi()
      recordMethod = 'api'
      sources.api = `ok (${records.length} Bibliotheken)`
    } catch (e) {
      sources.api = `Fehler: ${e.message}`
    }
  }
  if (!records && config.apertureDbUrl) {
    try {
      records = await recordsFromDb()
      recordMethod = 'db'
      sources.db = `ok (${records.length} Bibliotheken)`
    } catch (e) {
      sources.db = `Fehler: ${e.message}`
    }
  } else if (records && config.apertureDbUrl) {
    sources.db = 'nicht benötigt (API liefert die Zuordnung)'
  }

  const result = new Map() // folder guid -> entry
  const entryFor = (f) => {
    const guid = f.Guid || f.ItemId || f.Id
    if (!result.has(guid)) result.set(guid, { guid, itemId: f.ItemId || f.Id, name: f.Name, mediaType: typeFromCollection(f), ownerId: null, ownerName: null, method: null, problem: null })
    return result.get(guid)
  }
  const assign = (entry, user, method) => {
    if (entry.ownerId || !user) return
    entry.ownerId = user.Id
    entry.ownerName = user.Name
    entry.method = method
    entry.problem = null
  }

  // 1 / 2: Aperture's own records
  for (const r of records || []) {
    const f = folderIndex.get(norm(r.libraryGuid)) || folderIndex.get(norm(r.libraryId)) || folderByName.get(String(r.name || '').toLowerCase())
    if (!f) continue // Aperture remembers a library that Emby no longer has
    const e = entryFor(f)
    e.mediaType = r.mediaType
    const user = userById.get(norm(r.embyUserId))
    if (user) assign(e, user, recordMethod)
    else e.problem = `Aperture-Benutzer ${r.apertureUser || '?'} (${r.embyUserId || 'ohne Emby-ID'}) existiert in Emby nicht`
  }

  // 3: folder path
  for (const f of folders) {
    const p = pathOwnerKey(f.Locations)
    if (!p) continue
    const e = entryFor(f)
    if (p.series) e.mediaType = 'series'
    const user = userById.get(p.key)
    if (user) assign(e, user, 'path')
    else if (!e.ownerId && !e.problem) e.problem = 'Ordnerpfad enthält keine bekannte Emby-Benutzer-ID'
  }

  // 4: name pattern
  const rx = patternRegex(settings.apertureNamePattern, settings.apertureTypeMovies, settings.apertureTypeSeries)
  for (const f of folders) {
    const m = rx.exec(f.Name.normalize('NFC'))
    if (!m) continue
    const e = entryFor(f)
    if (m.groups?.type) e.mediaType = m.groups.type.toLowerCase() === settings.apertureTypeSeries.toLowerCase() ? 'series' : 'movies'
    const user = userByName.get(m.groups.username.trim().toLowerCase())
    if (user) assign(e, user, 'name')
    else if (!e.ownerId && !e.problem) e.problem = `Kein Emby-Benutzer namens „${m.groups.username.trim()}“`
  }

  return { libraries: [...result.values()], sources, recordMethod }
}
