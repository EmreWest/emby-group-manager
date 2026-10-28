// Home screen templates: storage and the normalised template shape.
//
// A template is an ordered list of rows plus library-level options (order, hidden in "Meine Medien", hidden in
// "Neu hinzugefügt" & co., landing screens) and the rotation settings. Row kinds:
//   section     any Emby section type (resume, latestmediablock, userviews, items, …) with an optional library filter
//   aperture    placeholder for the user's own Aperture library (movies or series), resolved per user
//   collection  a fixed collection (boxset row)
//   seasonal    a collection looked up by name; shown only while it exists and has items
//   rotation    one rotation slot, filled from the template's pool (seasonal collections first)
// Library references are library Guids, or '@aperture:movies' / '@aperture:series' for the user's own ones.

import crypto from 'node:crypto'
import { all, get, run, now, parseJson } from './db.js'
import { HttpError } from './http.js'

export const SECTION_TYPES = {
  userviews: 'Meine Medien',
  resume: 'Weiterschauen',
  resumeaudio: 'Weiterhören',
  latestmediablock: 'Neu hinzugefügt (je Bibliothek)',
  latestmoviereleases: 'Neu erschienene Filme',
  latestepisodereleases: 'Neu erschienene Episoden',
  nextup: 'Als Nächstes (Legacy)',
  collections: 'Kollektionen',
  playlists: 'Wiedergabelisten',
  items: 'Medien eines Typs',
  onnow: 'Jetzt im TV',
  activerecordings: 'Laufende Aufnahmen',
}

export const ROW_KINDS = ['section', 'aperture', 'collection', 'seasonal', 'rotation']
const LIB_MODES = ['all', 'only', 'except']

const str = (v) => (v == null ? '' : String(v).trim())
const list = (v) => [...new Set((Array.isArray(v) ? v : []).map((x) => String(x).trim()).filter(Boolean))]
const mmdd = (v) => (/^\d{2}-\d{2}$/.test(str(v)) ? str(v) : '')

export function newRowId() {
  return 'r' + crypto.randomBytes(4).toString('hex')
}

function normalizeRow(r = {}) {
  const kind = ROW_KINDS.includes(r.kind) ? r.kind : 'section'
  const row = {
    id: str(r.id) || newRowId(),
    kind,
    customName: str(r.customName),
    subtitle: str(r.subtitle),
    viewType: str(r.viewType),
    imageType: str(r.imageType),
    scrollDirection: ['Horizontal', 'Vertical'].includes(r.scrollDirection) ? r.scrollDirection : '',
    displayMode: str(r.displayMode),
    sortBy: str(r.sortBy),
    sortOrder: ['Ascending', 'Descending'].includes(r.sortOrder) ? r.sortOrder : '',
    cardSizeOffset: Number.isFinite(Number(r.cardSizeOffset)) ? Number(r.cardSizeOffset) : 0,
  }
  if (kind === 'section') {
    row.sectionType = str(r.sectionType) || 'resume'
    row.itemTypes = list(r.itemTypes)
    row.includeNextUp = r.includeNextUp !== false
    row.libraries = { mode: LIB_MODES.includes(r.libraries?.mode) ? r.libraries.mode : 'all', guids: list(r.libraries?.guids) }
    row.query = r.query && typeof r.query === 'object' ? r.query : {}
  }
  if (kind === 'aperture') {
    row.mediaType = r.mediaType === 'series' ? 'series' : 'movies'
    row.apertureStyle = r.apertureStyle === 'latest' ? 'latest' : 'items'
  }
  if (kind === 'collection') {
    row.collectionId = str(r.collectionId)
    row.collectionName = str(r.collectionName)
  }
  if (kind === 'seasonal') {
    row.collectionName = str(r.collectionName)
    row.season = { from: mmdd(r.season?.from), to: mmdd(r.season?.to) }
  }
  return row
}

// Older templates also had template-wide "hidden in Meine Medien / Neu hinzugefügt" lists (myMediaHidden,
// latestHidden), mostly filled from Emby's MyMediaExcludes / LatestItemsExcludes by "Als Vorlage speichern".
// Those were leftovers nobody could see in Emby 4.10 and hid whole libraries, so they are dropped: a row shows
// what its own library filter says, nothing else.
export function normalizeConfig(c = {}) {
  const rot = c.rotation || {}
  const rows = (Array.isArray(c.rows) ? c.rows : []).map(normalizeRow)
  return {
    rows,
    libraryOrder: list(c.libraryOrder),
    hidePlayedInLatest: !!c.hidePlayedInLatest,
    landing: Object.fromEntries(Object.entries(c.landing || {}).map(([k, v]) => [k, str(v)]).filter(([k]) => k)),
    tvHome: ['vertical', 'horizontal'].includes(c.tvHome) ? c.tvHome : '',
    rotation: {
      enabled: !!rot.enabled,
      interval: rot.interval === 'weekly' ? 'weekly' : 'daily',
      weekday: Number.isInteger(Number(rot.weekday)) ? Math.min(6, Math.max(0, Number(rot.weekday))) : 1,
      time: /^\d{2}:\d{2}$/.test(str(rot.time)) ? str(rot.time) : '04:00',
      avoidLastN: Math.max(0, Number(rot.avoidLastN) || 0),
      minVisibleRatio: Math.min(1, Math.max(0, rot.minVisibleRatio == null ? 0.5 : Number(rot.minVisibleRatio))),
      pool: (Array.isArray(rot.pool) ? rot.pool : [])
        .map((p) => ({ collectionId: str(p.collectionId), collectionName: str(p.collectionName), weight: Math.min(10, Math.max(1, Number(p.weight) || 1)) }))
        .filter((p) => p.collectionId || p.collectionName),
      seasonal: (Array.isArray(rot.seasonal) ? rot.seasonal : [])
        .map((s) => ({ collectionName: str(s.collectionName), season: { from: mmdd(s.season?.from), to: mmdd(s.season?.to) } }))
        .filter((s) => s.collectionName),
    },
  }
}

export function defaultTemplateConfig() {
  return normalizeConfig({
    rows: [
      { kind: 'section', sectionType: 'userviews' },
      { kind: 'section', sectionType: 'resume' },
      { kind: 'aperture', mediaType: 'movies' },
      { kind: 'aperture', mediaType: 'series' },
      { kind: 'section', sectionType: 'latestmediablock' },
    ],
    libraryOrder: ['@aperture:movies', '@aperture:series'],
  })
}

function row(t) {
  return { id: t.id, name: t.name, description: t.description, config: normalizeConfig(parseJson(t.config, {})), updatedAt: t.updated_at }
}

export function listTemplates() {
  return all('SELECT * FROM templates ORDER BY name COLLATE NOCASE').map(row)
}

export function getTemplate(id) {
  const t = get('SELECT * FROM templates WHERE id = ?', id)
  if (!t) throw new HttpError(404, 'Vorlage nicht gefunden')
  return row(t)
}

export function saveTemplate(id, body) {
  const name = str(body.name)
  if (!name) throw new HttpError(400, 'Name fehlt')
  const cfg = normalizeConfig(body.config || defaultTemplateConfig())
  if (id) {
    if (!get('SELECT id FROM templates WHERE id = ?', id)) throw new HttpError(404, 'Vorlage nicht gefunden')
    run('UPDATE templates SET name=?, description=?, config=?, updated_at=? WHERE id=?', name, str(body.description), JSON.stringify(cfg), now(), id)
  } else {
    id = Number(run('INSERT INTO templates (name, description, config, created_at, updated_at) VALUES (?,?,?,?,?)', name, str(body.description), JSON.stringify(cfg), now(), now()).lastInsertRowid)
  }
  return getTemplate(id)
}

export function deleteTemplate(id) {
  run('DELETE FROM templates WHERE id = ?', id)
}
