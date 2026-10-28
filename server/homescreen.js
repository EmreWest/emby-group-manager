// Resolving a template for one user, writing it to Emby, backups and restore.
//
// Where Emby 4.10 keeps a home screen (verified, see docs/EMBY-API.md):
//   rows             /Users/{id}/HomeSections (server side, per user, the same on every device)
//   library order    user Configuration.OrderedViews (MyMediaExcludes / LatestItemsExcludes are cleared, see below)
//   landing screens  /UserSettings/{id} keys "landing-<library guid>", TV layout key "tvhome"
// A user who never saved a home screen has no stored rows; Emby then shows its legacy defaults, and its REST layer
// stores those defaults before the first change (EnsureSavedSections). That is why writing adds our rows first and
// deletes the old ones afterwards: an empty list in between would bring the defaults back.

import crypto from 'node:crypto'
import { emby } from './emby.js'
import { all, get, run, now, parseJson } from './db.js'
import { getSettings } from './settings.js'
import { logChange } from './changelog.js'
import { SECTION_TYPES, normalizeConfig, newRowId } from './templates.js'
import { activeSeasonals, fillSlots, rankedFor } from './rotation.js'
import { inSeason } from './seasons.js'

const norm = (s) => String(s || '').toLowerCase().replace(/-/g, '')
const uniq = (a) => [...new Set(a)]
const viewKey = (v) => v.Guid || v.Id
const EDITABLE = ['SectionType', 'CustomName', 'Subtitle', 'ViewType', 'ImageType', 'DisplayMode', 'ScrollDirection', 'ParentId', 'SortBy', 'SortOrder', 'ItemTypes', 'IncludeNextUpInResume', 'ExcludedFolders', 'Query', 'CardSizeOffset', 'RefreshInterval']
const LEGACY_IDS = new Set(['smalllibrarytiles', 'librarybuttons', 'librarytiles', 'resume', 'resumeaudio', 'livetv', 'onnow', 'latestmedia', 'latestmediablock', 'nextup', 'none', 'activerecordings', 'latestmoviereleases', 'latestepisodereleases', 'collections', 'playlists'])
const CONFIG_KEYS = ['OrderedViews', 'MyMediaExcludes', 'LatestItemsExcludes', 'HidePlayedInLatest']
const SETTINGS_PREFIXES = ['landing-', 'homesection', 'tvhome']
const TYPE_LABEL = { movies: 'Filme', series: 'Serien' }

export const isLegacy = (sections) => !sections.length || sections.every((s) => s.Id === s.SectionType || LEGACY_IDS.has(String(s.Id).toLowerCase()))

export function sectionLabel(s) {
  return s.CustomName || s.Name || SECTION_TYPES[s.SectionType] || s.SectionType
}

function expandTokens(state, userId, tokens) {
  return tokens.flatMap((t) =>
    t.startsWith('@aperture:') ? state.libraries.filter((l) => l.aperture?.ownerId === userId && l.aperture.mediaType === t.slice(10)).map((l) => l.guid) : [t])
}

// Library tokens -> the user's views. Tokens: a library Guid, '@aperture:movies|series' (the user's own), or
// '@type:livetv|boxsets|playlists' for the views that are not libraries (Live TV, Kollektionen, Wiedergabelisten).
function matchViews(state, userId, views, tokens) {
  const out = []
  for (const t of tokens) {
    const hits = t.startsWith('@type:')
      ? views.filter((v) => String(v.CollectionType || '').toLowerCase() === t.slice(6))
      : views.filter((v) => expandTokens(state, userId, [t]).some((g) => norm(g) === norm(v.Guid) || norm(g) === norm(v.Id)))
    for (const v of hits) if (!out.includes(v)) out.push(v)
  }
  return out
}

function viewIdsFor(views, guids) {
  const set = new Set(guids.map(norm))
  return views.filter((v) => set.has(norm(v.Guid)) || set.has(norm(v.Id))).map((v) => v.Id)
}

function baseSection(row) {
  return {
    SectionType: null,
    CustomName: row.customName || null,
    Subtitle: row.subtitle || null,
    ViewType: row.viewType || null,
    ImageType: row.imageType || null,
    DisplayMode: row.displayMode || null,
    ScrollDirection: row.scrollDirection || null,
    ParentId: null,
    SortBy: row.sortBy || null,
    SortOrder: row.sortOrder || null,
    ItemTypes: [],
    IncludeNextUpInResume: true,
    ExcludedFolders: [],
    Query: {},
    CardSizeOffset: row.cardSizeOffset || 0,
  }
}

/**
 * Template -> what one user's home screen will be. Without a user (generic preview) placeholders stay unresolved.
 * @returns {{ rows: Array<{rowId, kind, label, note, section, predicted}>, sections, configuration, userSettings }}
 */
export async function resolveTemplate(template, { state, user = null, views = null, cctx, date = new Date(), today = true }) {
  const cfg = template.config
  const rot = cfg.rotation
  const userId = user?.Id || null
  const ranked = await rankedFor(template, cctx, date)
  const seasonal = await activeSeasonals(rot.seasonal, cctx, { date, today, userId, minRatio: rot.minVisibleRatio })
  const slots = await fillSlots(template, cctx, { userId, ranked, seasonal })
  const expand = (tokens) => expandTokens(state, userId, tokens)
  const viewIds = (tokens) => matchViews(state, userId, views || [], tokens).map((v) => v.Id)
  let slotIndex = 0
  const rows = []
  const add = (row, section, label, extra = {}) => rows.push({ rowId: row.id, kind: row.kind, label, section, ...extra })

  for (const row of cfg.rows) {
    if (row.kind === 'section') {
      const s = { ...baseSection(row), SectionType: row.sectionType, ItemTypes: row.itemTypes, IncludeNextUpInResume: row.includeNextUp, Query: { ...row.query } }
      if (cfg.hidePlayedInLatest && row.sectionType === 'latestmediablock') s.Query.IsPlayed = false
      const label = row.customName || SECTION_TYPES[row.sectionType] || row.sectionType
      if (views) {
        let excluded = []
        if (row.libraries.mode === 'only') {
          const keep = new Set(viewIds(row.libraries.guids))
          if (!keep.size) {
            add(row, null, label, { note: 'Keine der gewählten Bibliotheken ist für diesen Benutzer sichtbar' })
            continue
          }
          excluded = views.filter((v) => !keep.has(v.Id)).map((v) => v.Id)
        } else if (row.libraries.mode === 'except') {
          excluded = viewIds(row.libraries.guids)
        }
        s.ExcludedFolders = uniq(excluded).sort()
      }
      add(row, s, label)
    } else if (row.kind === 'aperture') {
      const typeLabel = TYPE_LABEL[row.mediaType]
      if (!user) {
        add(row, null, row.customName || `Eigene Aperture-${typeLabel}`, { placeholder: true })
        continue
      }
      const guids = expand([`@aperture:${row.mediaType}`])
      const ids = views ? viewIdsFor(views, guids) : []
      if (!ids.length) {
        add(row, null, row.customName || `Eigene Aperture-${typeLabel}`, { note: 'Noch keine Aperture-Bibliothek (oder nicht freigegeben)' })
        continue
      }
      const lib = state.libraries.find((l) => l.guid === guids[0])
      const s = baseSection(row)
      if (row.apertureStyle === 'latest') {
        s.SectionType = 'latestmediablock'
      } else {
        s.SectionType = 'items'
        s.ItemTypes = [row.mediaType === 'series' ? 'Series' : 'Movie']
        s.CustomName = row.customName || lib?.name || null
        s.SortBy = row.sortBy || 'DateCreated'
        s.SortOrder = row.sortOrder || 'Descending'
      }
      // sorted, so the result does not depend on the user's current library order (keeps re-applying idempotent)
      s.ExcludedFolders = views.filter((v) => !ids.includes(v.Id)).map((v) => v.Id).sort()
      add(row, s, s.CustomName || lib?.name || typeLabel)
    } else if (row.kind === 'collection') {
      const c = cctx.find({ id: row.collectionId, name: row.collectionName })
      if (!c?.id) {
        add(row, null, row.customName || row.collectionName || 'Kollektion', { note: 'Kollektion nicht gefunden', hidden: true })
        continue
      }
      if (!(await cctx.total(c))) {
        add(row, null, row.customName || c.name, { note: 'Kollektion ist leer – ausgeblendet', hidden: true })
        continue
      }
      add(row, { ...baseSection(row), SectionType: 'boxset', ParentId: c.id }, row.customName || c.name)
    } else if (row.kind === 'seasonal') {
      const c = cctx.find({ name: row.collectionName })
      const window = row.season?.from ? row.season : c?.uc?.season || null
      const on = window ? inSeason(window, date) : null
      const label = row.customName || row.collectionName
      if (on === false) {
        add(row, null, label, { note: 'Außerhalb der Saison – ausgeblendet', hidden: true })
        continue
      }
      const usable = await cctx.usable(c, userId, rot.minVisibleRatio)
      if (usable) add(row, { ...baseSection(row), SectionType: 'boxset', ParentId: c.id }, row.customName || c.name, { predicted: !today })
      else if (!today && on) add(row, null, label, { note: 'Saison aktiv – Kollektion wird voraussichtlich angelegt', predicted: true })
      else add(row, null, label, { note: c?.id ? 'Leer oder für diesen Benutzer größtenteils gesperrt – ausgeblendet' : 'Existiert nicht – ausgeblendet', hidden: true })
    } else if (row.kind === 'rotation') {
      const slot = slots[slotIndex++]
      if (!slot) {
        add(row, null, `Rotationsplatz ${slotIndex}`, { note: 'Kein passender Kandidat – ausgeblendet', hidden: true })
        continue
      }
      const extra = { source: slot.source, predicted: !!slot.predicted }
      if (!slot.collection) add(row, null, `${slot.name} (Saison)`, { ...extra, note: 'Wird voraussichtlich angelegt' })
      else add(row, { ...baseSection(row), SectionType: 'boxset', ParentId: slot.collection.id, CustomName: row.customName || null }, slot.collection.name, extra)
    }
  }

  let configuration = null
  let userSettings = null
  if (user && views) {
    const ordered = []
    for (const token of cfg.libraryOrder) for (const v of matchViews(state, userId, views, [token])) if (!ordered.includes(viewKey(v))) ordered.push(viewKey(v))
    for (const v of views) if (!ordered.includes(viewKey(v))) ordered.push(viewKey(v))
    // Emby compares OrderedViews with the folder's IdString (UserViewManager.GetUserViews), which is what the views
    // list returns as Guid; Id is the fallback, as in Emby's own settings page.
    const keysFor = (tokens) => matchViews(state, userId, views, tokens).map(viewKey)
    // Library selection lives in the rows' ExcludedFolders. MyMediaExcludes is cleared because Emby applies it to
    // every "Meine Medien" row and the library menu on top of that, invisibly (the 4.10 settings page no longer
    // shows it); LatestItemsExcludes only matters for Emby's legacy default rows.
    configuration = { OrderedViews: ordered, MyMediaExcludes: [], LatestItemsExcludes: [], HidePlayedInLatest: cfg.hidePlayedInLatest }
    userSettings = {}
    for (const [token, value] of Object.entries(cfg.landing)) {
      // Live TV's landing key is fixed ("landing-livetv"), the others use the library's Guid (settings/homescreen.js)
      const keys = token === '@type:livetv' ? ['livetv'] : keysFor([token])
      for (const key of keys) userSettings[`landing-${key}`] = value || null
    }
    if (cfg.tvHome) userSettings.tvhome = cfg.tvHome
  }

  return { rows, sections: rows.filter((r) => r.section).map((r) => r.section), configuration, userSettings }
}

export function hashResolved(resolved) {
  return crypto.createHash('sha1').update(JSON.stringify({ s: resolved.sections, c: resolved.configuration, u: resolved.userSettings })).digest('hex')
}

const signature = (s) => [s.SectionType, norm(s.ParentId), s.CustomName || '', s.SortBy || '', s.SortOrder || '', s.ViewType || '', (s.ExcludedFolders || []).map(norm).sort().join(','), (s.ItemTypes || []).join(',')].join('|')
export const sameLayout = (current, wanted) => current.length === wanted.length && current.every((s, i) => signature(s) === signature(wanted[i]))
const sameSection = (stored, sent) => stored.SectionType === sent.SectionType && norm(stored.ParentId) === norm(sent.ParentId) && (stored.CustomName || '') === (sent.CustomName || '')

/** Replaces a user's rows with `sections` (in order). Add first, delete after, then fix the order if needed. */
export async function writeSections(userId, sections) {
  if (!sections.length) throw new Error('Leere Startseite: Emby würde wieder seine Standardzeilen zeigen. Mindestens eine Zeile nötig.')
  let known = new Set((await emby.homeSections(userId)).map((s) => s.Id))
  const ours = []
  for (const sec of sections) {
    await emby.addHomeSection(userId, sec)
    const after = await emby.homeSections(userId)
    const fresh = after.filter((s) => !known.has(s.Id))
    // Usually exactly one new id. For a user with only legacy defaults Emby stores those first, so several ids are
    // new; ours is the last one that matches what we sent.
    const mine = fresh.length === 1 ? fresh[0] : [...fresh].reverse().find((s) => sameSection(s, sec))
    if (!mine) throw new Error(`Neue Zeile „${sectionLabel(sec)}“ nicht wiedergefunden`)
    ours.push(mine.Id)
    known = new Set(after.map((s) => s.Id))
  }
  const others = (await emby.homeSections(userId)).map((s) => s.Id).filter((id) => !ours.includes(id))
  if (others.length) await emby.deleteHomeSections(userId, others)
  let current = (await emby.homeSections(userId)).map((s) => s.Id)
  if (current.join() !== ours.join()) {
    for (let i = 0; i < ours.length; i++) await emby.moveHomeSections(userId, [ours[i]], i)
    current = (await emby.homeSections(userId)).map((s) => s.Id)
    if (current.join() !== ours.join()) throw new Error('Reihenfolge der Zeilen konnte nicht gesetzt werden')
  }
  return ours
}

// ---- backups ----

const pickConfig = (c = {}) => Object.fromEntries(CONFIG_KEYS.map((k) => [k, c[k]]))
const pickSettings = (s = {}) => Object.fromEntries(Object.entries(s || {}).filter(([k]) => SETTINGS_PREFIXES.some((p) => k.startsWith(p))))

export async function takeBackup(userId, { kind, reason = '' }) {
  const [user, sections, settings] = await Promise.all([emby.user(userId), emby.homeSections(userId), emby.userSettings(userId).catch(() => ({}))])
  const data = { sections, legacy: isLegacy(sections), userSettings: pickSettings(settings), configuration: pickConfig(user.Configuration) }
  const isOriginal = !get('SELECT id FROM backups WHERE user_id = ?', userId)
  const id = Number(run('INSERT INTO backups (user_id, user_name, kind, reason, is_original, data, created_at) VALUES (?,?,?,?,?,?,?)', userId, user.Name, kind, reason, isOriginal ? 1 : 0, JSON.stringify(data), now()).lastInsertRowid)
  const keep = getSettings().backupsPerUser
  const old = all('SELECT id FROM backups WHERE user_id = ? AND is_original = 0 ORDER BY id DESC LIMIT -1 OFFSET ?', userId, keep)
  for (const b of old) run('DELETE FROM backups WHERE id = ?', b.id)
  return id
}

export function listBackups(userId = null) {
  const rows = userId ? all('SELECT * FROM backups WHERE user_id = ? ORDER BY id DESC', userId) : all('SELECT * FROM backups ORDER BY id DESC LIMIT 500')
  return rows.map((b) => {
    const data = parseJson(b.data, {})
    return { id: b.id, userId: b.user_id, userName: b.user_name, kind: b.kind, reason: b.reason, isOriginal: !!b.is_original, createdAt: b.created_at, legacy: !!data.legacy, rows: (data.sections || []).map(sectionLabel) }
  })
}

export function getBackup(id) {
  const b = get('SELECT * FROM backups WHERE id = ?', id)
  return b ? { ...b, data: parseJson(b.data, {}) } : null
}

export async function restoreBackup(id, { actor, dryRun }) {
  const b = getBackup(id)
  if (!b) throw new Error('Backup nicht gefunden')
  const { sections = [], userSettings = {}, configuration = {} } = b.data
  if (dryRun) {
    logChange({ actor, action: 'homescreen.restore', target: b.user_name, summary: `Backup #${id} vom ${b.created_at}`, dryRun: true })
    return { dryRun: true }
  }
  await takeBackup(b.user_id, { kind: 'vor-wiederherstellung', reason: `vor Wiederherstellung von Backup #${id}` })
  const clean = sections.map((s) => Object.fromEntries(EDITABLE.filter((k) => k in s).map((k) => [k, s[k]])))
  await writeSections(b.user_id, clean)
  const cfg = Object.fromEntries(Object.entries(configuration).filter(([, v]) => v !== undefined))
  if (Object.keys(cfg).length) await emby.updateConfigurationPartial(b.user_id, cfg)
  const current = pickSettings(await emby.userSettings(b.user_id).catch(() => ({})))
  const patch = { ...Object.fromEntries(Object.keys(current).filter((k) => !(k in userSettings)).map((k) => [k, null])), ...userSettings }
  if (Object.keys(patch).length) await emby.updateUserSettingsPartial(b.user_id, patch)
  run('DELETE FROM user_layout_state WHERE user_id = ?', b.user_id)
  logChange({ actor, action: 'homescreen.restore', target: b.user_name, summary: `Backup #${id} vom ${b.created_at} wiederhergestellt`, details: { rows: clean.map(sectionLabel) } })
  return { restored: true }
}

// ---- applying ----

export function layoutState(userId) {
  return get('SELECT * FROM user_layout_state WHERE user_id = ?', userId) || null
}

/**
 * Applies a template to one user. force=false skips users whose rows already match.
 * @returns {{ status: 'applied'|'unchanged'|'dry-run', rows: string[] }}
 */
export async function applyTemplateToUser(template, userId, { state, cctx, actor, dryRun, force = false, reason = '', backupKind = 'manuell' }) {
  const user = await emby.user(userId)
  const views = await emby.userViews(userId)
  const resolved = await resolveTemplate(template, { state, user, views, cctx })
  const hash = hashResolved(resolved)
  const labels = resolved.rows.filter((r) => r.section).map((r) => r.label)
  if (!force) {
    const current = await emby.homeSections(userId)
    const st = layoutState(userId)
    if (sameLayout(current, resolved.sections) && st?.applied_hash === hash) return { status: 'unchanged', rows: labels }
  }
  if (dryRun) {
    logChange({ actor, action: 'homescreen.apply', target: user.Name, summary: `Vorlage „${template.name}“${reason ? ' – ' + reason : ''}`, details: { rows: labels }, dryRun: true })
    return { status: 'dry-run', rows: labels }
  }
  const backupId = await takeBackup(userId, { kind: backupKind, reason: `vor Vorlage „${template.name}“` })
  try {
    await writeSections(userId, resolved.sections)
    if (resolved.configuration) await emby.updateConfigurationPartial(userId, resolved.configuration)
    if (resolved.userSettings && Object.keys(resolved.userSettings).length) await emby.updateUserSettingsPartial(userId, resolved.userSettings)
  } catch (e) {
    logChange({ actor, action: 'homescreen.apply', target: user.Name, summary: `${e.message} (Backup #${backupId} kann wiederhergestellt werden)`, ok: false })
    throw e
  }
  run(
    `INSERT INTO user_layout_state (user_id, template_id, applied_hash, applied_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET template_id = excluded.template_id, applied_hash = excluded.applied_hash, applied_at = excluded.applied_at`,
    userId, template.id, hash, now(),
  )
  logChange({ actor, action: 'homescreen.apply', target: user.Name, summary: `Vorlage „${template.name}“${reason ? ' – ' + reason : ''} (Backup #${backupId})`, details: { rows: labels, configuration: resolved.configuration, userSettings: resolved.userSettings } })
  return { status: 'applied', rows: labels, backupId }
}

// ---- user -> template ----

export async function templateFromUser(state, userId) {
  const [user, sections, views, settings] = await Promise.all([emby.user(userId), emby.homeSections(userId), emby.userViews(userId), emby.userSettings(userId).catch(() => ({}))])
  const own = state.libraries.filter((l) => l.aperture?.ownerId === userId)
  const tokenFor = (key) => {
    if (key === 'livetv') return '@type:livetv'
    const v = views.find((x) => norm(x.Id) === norm(key) || norm(x.Guid) === norm(key))
    if (v && ['livetv', 'boxsets', 'playlists'].includes(String(v.CollectionType).toLowerCase())) return `@type:${String(v.CollectionType).toLowerCase()}`
    // ids of libraries that no longer exist (Emby keeps them in these lists) are dropped
    if (!v) return null
    const guid = v.Guid || v.Id
    const ap = own.find((l) => norm(l.guid) === norm(guid))
    return ap ? `@aperture:${ap.aperture.mediaType}` : guid
  }
  const tokens = (keys) => (keys || []).map(tokenFor).filter(Boolean)
  const rows = sections.map((s) => {
    const shown = views.filter((v) => !(s.ExcludedFolders || []).some((x) => norm(x) === norm(v.Id) || norm(x) === norm(v.Guid)))
    const common = { id: newRowId(), customName: s.CustomName || '', subtitle: s.Subtitle || '', viewType: s.ViewType || '', imageType: s.ImageType || '', scrollDirection: s.ScrollDirection || '', displayMode: s.DisplayMode || '', sortBy: s.SortBy || '', sortOrder: s.SortOrder || '', cardSizeOffset: s.CardSizeOffset || 0 }
    if (s.SectionType === 'boxset' && s.ParentId) return { ...common, kind: 'collection', collectionId: s.ParentId, collectionName: s.ParentItem?.Name || s.Name || '' }
    if (['items', 'latestmediablock'].includes(s.SectionType) && shown.length === 1) {
      const ap = own.find((l) => norm(l.guid) === norm(shown[0].Guid) || norm(l.itemId) === norm(shown[0].Id))
      if (ap) return { ...common, kind: 'aperture', mediaType: ap.aperture.mediaType, apertureStyle: s.SectionType === 'latestmediablock' ? 'latest' : 'items', customName: s.CustomName === ap.name ? '' : common.customName }
    }
    const excluded = tokens(s.ExcludedFolders)
    return { ...common, kind: 'section', sectionType: s.SectionType, itemTypes: s.ItemTypes || [], includeNextUp: s.IncludeNextUpInResume !== false, libraries: { mode: excluded.length ? 'except' : 'all', guids: excluded }, query: s.Query || {} }
  })
  const c = user.Configuration || {}
  const landing = {}
  for (const [k, v] of Object.entries(settings || {})) {
    const token = k.startsWith('landing-') && v ? tokenFor(k.slice(8)) : null
    if (token) landing[token] = v
  }
  return normalizeConfig({
    rows,
    libraryOrder: tokens(c.OrderedViews),
    // Emby applies MyMediaExcludes to "Meine Medien" on top of the row, so it belongs to that row's filter
    // (normalizeConfig folds it in). LatestItemsExcludes has no effect on stored rows and is not taken over.
    myMediaHidden: tokens(c.MyMediaExcludes),
    hidePlayedInLatest: !!c.HidePlayedInLatest,
    landing,
    tvHome: settings?.tvhome || '',
  })
}
