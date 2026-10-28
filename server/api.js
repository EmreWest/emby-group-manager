// REST API for the web UI. Every route except /api/auth/* needs a session.

import { createRouter, HttpError } from './http.js'
import { config } from './config.js'
import { all, get, run, now, parseJson } from './db.js'
import { emby, embyConfigured } from './emby.js'
import { apertureVersion, patternRegex, TESTED_APERTURE_VERSION } from './aperture.js'
import { loadState, invalidateState } from './state.js'
import { getSettings, setSettings } from './settings.js'
import { listChanges, logChange } from './changelog.js'
import * as groups from './groups.js'
import { effectiveRights, previewUsers, applyUserPolicy, userWarnings } from './policy.js'
import * as templates from './templates.js'
import { loadCollections, createCollectionContext } from './collections.js'
import { getRotationState, rotationHistory, rollTemplate, nextScheduled, slotCount } from './rotation.js'
import { resolveTemplate, applyTemplateToUser, templateFromUser, takeBackup, listBackups, getBackup, restoreBackup, isLegacy, sectionLabel, sameLayout, layoutState } from './homescreen.js'
import { runSync, syncRunning } from './sync.js'

export const api = createRouter()
const id = (p) => {
  const n = Number(p)
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Ungültige ID')
  return n
}
const actorOf = (session) => session.username
const dry = () => getSettings().dryRun

// ---- status ----

api.get('/api/status', async () => {
  const settings = getSettings()
  const out = {
    emby: { configured: embyConfigured(), url: config.embyUrl, ok: false },
    aperture: { url: config.apertureUrl || null, db: Boolean(config.apertureDbUrl), version: null, testedVersion: TESTED_APERTURE_VERSION },
    dryRun: settings.dryRun,
    syncIntervalMinutes: settings.syncIntervalMinutes,
    lastSync: settings.lastSync,
    syncRunning: syncRunning(),
    warnings: [],
  }
  if (!embyConfigured()) {
    out.warnings.push('EMBY_URL und EMBY_API_KEY sind nicht gesetzt.')
    return out
  }
  try {
    const info = await emby.systemInfo()
    out.emby = { ...out.emby, ok: true, serverName: info.ServerName, version: info.Version }
    if (!/^4\.(1\d|[1-9]\d)\./.test(info.Version || '')) out.warnings.push(`Emby ${info.Version}: getestet ist 4.10. Die Homescreen-Funktionen brauchen mindestens 4.10.0.4.`)
  } catch (e) {
    out.emby.error = e.message
    return out
  }
  out.aperture.version = await apertureVersion()
  const state = await loadState()
  out.aperture.sources = state.aperture.sources
  out.aperture.method = state.aperture.recordMethod
  out.counts = {
    users: state.users.length,
    libraries: state.libraries.filter((l) => !l.aperture).length,
    aperture: state.libraries.filter((l) => l.aperture).length,
    libraryGroups: groups.listLibraryGroups().length,
    templates: templates.listTemplates().length,
    layoutGroups: groups.listLayoutGroups().length,
  }
  for (const l of state.libraries.filter((x) => x.aperture && !x.aperture.ownerId)) out.warnings.push(`Aperture-Bibliothek „${l.name}“ ist keinem Benutzer zugeordnet (${l.aperture.problem || 'unbekannt'}) und wird nicht freigegeben.`)
  if (out.aperture.version && !String(out.aperture.version).includes(TESTED_APERTURE_VERSION)) out.warnings.push(`Aperture ${out.aperture.version}: geprüft wurde gegen ${TESTED_APERTURE_VERSION}. Bitte die Zuordnung unter „Bibliotheken“ kontrollieren.`)
  return out
})

api.get('/api/meta', async () => ({
  sectionTypes: templates.SECTION_TYPES,
  unratedTypes: ['Movie', 'Series', 'Trailer', 'Music', 'Book', 'Game', 'LiveTvChannel', 'LiveTvProgram', 'ChannelContent', 'Other'],
  itemTypes: ['Movie', 'Series', 'Movie,Series', 'Episode', 'MusicVideo', 'Video', 'Trailer', 'Audio', 'MusicAlbum', 'Book'],
  settings: getSettings(),
}))

// ---- users ----

api.get('/api/users', async () => {
  const state = await loadState()
  const lgs = groups.listLibraryGroups()
  const ygs = groups.listLayoutGroups()
  const tpls = templates.listTemplates()
  return state.users.map((u) => {
    const rights = effectiveRights(state, u, lgs)
    const yg = groups.layoutGroupOfUser(u.Id, ygs)
    const ls = layoutState(u.Id)
    const p = u.Policy || {}
    const rating = p.MaxParentalRating == null ? null : state.ratings.filter((r) => r.Value <= p.MaxParentalRating).pop()?.Name || String(p.MaxParentalRating)
    return {
      id: u.Id,
      name: u.Name,
      isAdmin: !!p.IsAdministrator,
      isDisabled: !!p.IsDisabled,
      isKids: rights.isKids,
      managed: rights.managed,
      libraryGroups: rights.groups,
      layoutGroup: yg ? { id: yg.id, name: yg.name } : null,
      template: ls ? { id: ls.template_id, name: tpls.find((t) => t.id === ls.template_id)?.name || '?', appliedAt: ls.applied_at } : null,
      aperture: state.libraries.filter((l) => l.aperture?.ownerId === u.Id).map((l) => ({ name: l.name, mediaType: l.aperture.mediaType, method: l.aperture.method })),
      allFolders: !!p.EnableAllFolders,
      folderCount: p.EnableAllFolders ? state.libraries.length : (p.EnabledFolders || []).length,
      rating,
      warnings: userWarnings(state, u, rights),
    }
  })
})

api.get('/api/users/:id', async ({ params }) => {
  const state = await loadState()
  const user = await emby.user(params.id)
  const [sections, preview] = await Promise.all([emby.homeSections(params.id).catch((e) => ({ error: e.message })), Promise.resolve(previewUsers({ ...state, users: [user] }))])
  const counts = Array.isArray(sections)
    ? await Promise.all(sections.map((s) => (s.SectionType === 'latestmediablock' ? null : emby.sectionItemCount(params.id, s.Id).catch(() => null))))
    : []
  return {
    id: user.Id,
    name: user.Name,
    policy: preview[0],
    effective: effectiveRights(state, user),
    homescreen: Array.isArray(sections) ? { legacy: isLegacy(sections), rows: sections.map((s, i) => ({ id: s.Id, label: sectionLabel(s), type: s.SectionType, sortBy: s.SortBy, items: counts[i], excluded: (s.ExcludedFolders || []).length })) } : sections,
    layoutState: layoutState(params.id),
    backups: listBackups(params.id),
  }
})

// ---- libraries / aperture ----

api.get('/api/libraries', async () => {
  const state = await loadState()
  const lgs = groups.listLibraryGroups()
  return {
    libraries: state.libraries.map((l) => ({ ...l, groups: lgs.filter((g) => g.libraryGuids.includes(l.guid)).map((g) => g.name) })),
    sources: state.aperture.sources,
    method: state.aperture.recordMethod,
  }
})

api.post('/api/aperture/test-pattern', async ({ body }) => {
  const state = await loadState()
  const s = getSettings()
  const rx = patternRegex(body.pattern ?? s.apertureNamePattern, body.typeMovies ?? s.apertureTypeMovies, body.typeSeries ?? s.apertureTypeSeries)
  const names = new Map(state.users.map((u) => [u.Name.toLowerCase(), u.Name]))
  return state.libraries
    .map((l) => {
      const m = rx.exec(l.name.normalize('NFC'))
      return m ? { library: l.name, username: m.groups.username.trim(), type: m.groups.type || null, user: names.get(m.groups.username.trim().toLowerCase()) || null } : null
    })
    .filter(Boolean)
})

api.get('/api/ratings', async () => (await loadState()).ratings)
api.post('/api/refresh', async () => {
  invalidateState()
  await loadState({ force: true })
  return { ok: true }
})

// ---- library groups + policy ----

api.get('/api/library-groups', () => groups.listLibraryGroups())
api.post('/api/library-groups', ({ body, session }) => {
  const g = groups.saveLibraryGroup(null, body)
  logChange({ actor: actorOf(session), action: 'group.create', target: g.name, summary: 'Bibliotheksgruppe angelegt' })
  return g
})
api.put('/api/library-groups/:id', ({ params, body, session }) => {
  const g = groups.saveLibraryGroup(id(params.id), body)
  logChange({ actor: actorOf(session), action: 'group.update', target: g.name, summary: 'Bibliotheksgruppe gespeichert (noch nicht angewendet)' })
  return g
})
api.delete('/api/library-groups/:id', ({ params, session }) => {
  const g = groups.getLibraryGroup(id(params.id))
  groups.deleteLibraryGroup(g.id)
  logChange({ actor: actorOf(session), action: 'group.delete', target: g.name, summary: 'Bibliotheksgruppe gelöscht' })
  return { ok: true }
})

function usersForScope(state, { groupId, userId }) {
  if (userId) return [userId]
  if (!groupId) return state.users.map((u) => u.Id)
  return groups.getLibraryGroup(id(groupId)).userIds
}

api.get('/api/policy/preview', async ({ query }) => {
  const state = await loadState({ force: true })
  return previewUsers(state, usersForScope(state, query))
})

api.post('/api/policy/apply', async ({ body, session }) => {
  invalidateState()
  const state = await loadState({ force: true })
  const results = []
  for (const userId of usersForScope(state, body)) {
    const u = state.users.find((x) => x.Id === userId)
    if (!u) continue
    try {
      const r = await applyUserPolicy(state, userId, { actor: actorOf(session), dryRun: dry(), reason: body.userId ? 'einzeln' : body.groupId ? `Gruppe #${body.groupId}` : 'alle Gruppen' })
      results.push({ user: u.Name, ...r })
    } catch (e) {
      results.push({ user: u.Name, error: e.message })
    }
  }
  invalidateState()
  return { dryRun: dry(), results }
})

// ---- collections ----

async function collectionContext() {
  const state = await loadState()
  return { state, cctx: createCollectionContext(await loadCollections(state)) }
}

api.get('/api/collections', async () => {
  const { cctx } = await collectionContext()
  return { ultimateCollections: cctx.collections.ultimateCollections, collections: cctx.collections.list }
})

// ---- templates ----

api.get('/api/templates', () =>
  templates.listTemplates().map((t) => ({ ...t, rotationState: getRotationState(t.id), slots: slotCount(t), nextRoll: t.config.rotation.enabled ? nextScheduled(t.config.rotation, new Date()).toISOString() : null })))
api.get('/api/templates/:id', ({ params }) => templates.getTemplate(id(params.id)))
api.post('/api/templates', ({ body, session }) => {
  const t = templates.saveTemplate(null, body)
  logChange({ actor: actorOf(session), action: 'template.create', target: t.name, summary: 'Vorlage angelegt' })
  return t
})
api.put('/api/templates/:id', ({ params, body, session }) => {
  const t = templates.saveTemplate(id(params.id), body)
  logChange({ actor: actorOf(session), action: 'template.update', target: t.name, summary: 'Vorlage gespeichert' })
  return t
})
api.delete('/api/templates/:id', ({ params, session }) => {
  const t = templates.getTemplate(id(params.id))
  templates.deleteTemplate(t.id)
  logChange({ actor: actorOf(session), action: 'template.delete', target: t.name, summary: 'Vorlage gelöscht' })
  return { ok: true }
})
api.get('/api/templates-default', () => templates.defaultTemplateConfig())

api.post('/api/templates/from-user', async ({ body, session }) => {
  const state = await loadState()
  const user = state.users.find((u) => u.Id === body.userId)
  if (!user) throw new HttpError(404, 'Benutzer nicht gefunden')
  const cfg = await templateFromUser(state, user.Id)
  const t = templates.saveTemplate(null, { name: body.name || `Startseite von ${user.Name}`, description: `Übernommen von ${user.Name} am ${new Date().toLocaleDateString('de-DE')}`, config: cfg })
  logChange({ actor: actorOf(session), action: 'template.create', target: t.name, summary: `Aus der Startseite von ${user.Name} übernommen` })
  return t
})

function previewDate(when) {
  const d = new Date()
  if (when === 'tomorrow') d.setDate(d.getDate() + 1)
  if (when === 'nextweek') d.setDate(d.getDate() + 7)
  return d
}

api.post('/api/templates/:id/preview', async ({ params, body }) => {
  // POST so the editor can preview unsaved changes: body.config overrides the stored one.
  const stored = templates.getTemplate(id(params.id))
  const template = body.config ? { ...stored, config: templates.normalizeConfig(body.config) } : stored
  const { state, cctx } = await collectionContext()
  const when = body.when || 'today'
  const date = previewDate(when)
  const user = body.userId ? await emby.user(body.userId) : null
  const views = user ? await emby.userViews(user.Id) : null
  const resolved = await resolveTemplate(template, { state, user, views, cctx, date, today: when === 'today' })
  return { date: date.toISOString(), when, user: user ? { id: user.Id, name: user.Name } : null, rows: resolved.rows.map(({ section, ...r }) => ({ ...r, shown: Boolean(section) || r.placeholder || (r.predicted && !r.hidden) })) }
})

api.post('/api/templates/:id/reroll', async ({ params, session }) => {
  const t = templates.getTemplate(id(params.id))
  const { state, cctx } = await collectionContext()
  const r = await rollTemplate(t, cctx, { manual: true })
  logChange({ actor: actorOf(session), action: 'rotation.roll', target: t.name, summary: `Manuell neu gewürfelt: ${r.shown.map((c) => c.name).join(', ') || 'keine Kandidaten'}`, dryRun: dry() })
  // apply to users that already carry this template
  const results = []
  for (const g of groups.listLayoutGroups().filter((x) => x.templateId === t.id)) {
    for (const userId of g.userIds) {
      if (layoutState(userId)?.template_id !== t.id) continue
      const name = state.users.find((u) => u.Id === userId)?.Name || userId
      try {
        results.push({ user: name, ...(await applyTemplateToUser(t, userId, { state, cctx, actor: actorOf(session), dryRun: dry(), reason: 'neu gewürfelt', backupKind: 'automatisch' })) })
      } catch (e) {
        results.push({ user: name, error: e.message })
      }
    }
  }
  return { shown: r.shown, seasonal: r.seasonal.map((s) => s.name), results, dryRun: dry() }
})

api.get('/api/templates/:id/history', ({ params }) => rotationHistory(id(params.id), 100))

// ---- layout groups ----

api.get('/api/layout-groups', () => groups.listLayoutGroups())
api.post('/api/layout-groups', ({ body, session }) => {
  const g = groups.saveLayoutGroup(null, body)
  logChange({ actor: actorOf(session), action: 'layout.create', target: g.name, summary: 'Layout-Gruppe angelegt' })
  return g
})
api.put('/api/layout-groups/:id', ({ params, body, session }) => {
  const g = groups.saveLayoutGroup(id(params.id), body)
  logChange({ actor: actorOf(session), action: 'layout.update', target: g.name, summary: 'Layout-Gruppe gespeichert' })
  return g
})
api.delete('/api/layout-groups/:id', ({ params, session }) => {
  const g = groups.getLayoutGroup(id(params.id))
  groups.deleteLayoutGroup(g.id)
  logChange({ actor: actorOf(session), action: 'layout.delete', target: g.name, summary: 'Layout-Gruppe gelöscht' })
  return { ok: true }
})

api.get('/api/layout-groups/:id/preview', async ({ params }) => {
  const g = groups.getLayoutGroup(id(params.id))
  if (!g.templateId) throw new HttpError(400, 'Der Gruppe ist keine Vorlage zugewiesen')
  const t = templates.getTemplate(g.templateId)
  const { state, cctx } = await collectionContext()
  const out = []
  for (const userId of g.userIds) {
    const user = state.users.find((u) => u.Id === userId)
    if (!user) continue
    try {
      const [views, current] = await Promise.all([emby.userViews(userId), emby.homeSections(userId)])
      const resolved = await resolveTemplate(t, { state, user, views, cctx })
      out.push({ userId, user: user.Name, legacy: isLegacy(current), current: current.map(sectionLabel), next: resolved.rows.filter((r) => r.section).map((r) => r.label), changed: !sameLayout(current, resolved.sections) })
    } catch (e) {
      out.push({ userId, user: user.Name, error: e.message })
    }
  }
  return { template: { id: t.id, name: t.name }, users: out }
})

api.post('/api/layout-groups/:id/apply', async ({ params, body, session }) => {
  const g = groups.getLayoutGroup(id(params.id))
  if (!g.templateId) throw new HttpError(400, 'Der Gruppe ist keine Vorlage zugewiesen')
  const t = templates.getTemplate(g.templateId)
  const { state, cctx } = await collectionContext()
  const only = Array.isArray(body.userIds) ? new Set(body.userIds) : null
  const results = []
  for (const userId of g.userIds) {
    if (only && !only.has(userId)) continue
    const name = state.users.find((u) => u.Id === userId)?.Name || userId
    try {
      results.push({ user: name, ...(await applyTemplateToUser(t, userId, { state, cctx, actor: actorOf(session), dryRun: dry(), force: !!body.force, reason: body.force ? 'alle überschreiben' : 'auf Mitglieder anwenden' })) })
    } catch (e) {
      results.push({ user: name, error: e.message })
    }
  }
  return { dryRun: dry(), results }
})

// ---- backups ----

api.get('/api/backups', ({ query }) => listBackups(query.userId || null))
api.get('/api/backups/:id', ({ params }) => {
  const b = getBackup(id(params.id))
  if (!b) throw new HttpError(404, 'Backup nicht gefunden')
  return b
})
api.post('/api/backups', async ({ body, session }) => {
  const backupId = await takeBackup(body.userId, { kind: 'manuell', reason: 'manuell angelegt' })
  logChange({ actor: actorOf(session), action: 'backup.create', target: body.userId, summary: `Backup #${backupId} angelegt` })
  return { id: backupId }
})
api.post('/api/backups/:id/restore', async ({ params, session }) => restoreBackup(id(params.id), { actor: actorOf(session), dryRun: dry() }))

// ---- diagnostics: raw snapshots of what Emby stores, to compare before / after a change in the Emby UI ----

api.post('/api/diagnostics/snapshot', async ({ body }) => {
  const user = await emby.user(body.userId)
  const [homeSections, userSettings, views] = await Promise.all([
    emby.homeSections(user.Id).catch((e) => ({ error: e.message })),
    emby.userSettings(user.Id).catch((e) => ({ error: e.message })),
    emby.userViews(user.Id).catch((e) => ({ error: e.message })),
  ])
  const data = { homeSections, userSettings, configuration: user.Configuration, policy: user.Policy, views: Array.isArray(views) ? views.map((v) => ({ Id: v.Id, Guid: v.Guid, Name: v.Name, CollectionType: v.CollectionType })) : views }
  const sid = Number(run('INSERT INTO snapshots (user_id, user_name, label, data, created_at) VALUES (?,?,?,?,?)', user.Id, user.Name, String(body.label || 'Snapshot'), JSON.stringify(data), now()).lastInsertRowid)
  return { id: sid }
})
api.get('/api/diagnostics/snapshots', ({ query }) =>
  (query.userId ? all('SELECT id, user_id, user_name, label, created_at FROM snapshots WHERE user_id = ? ORDER BY id DESC', query.userId) : all('SELECT id, user_id, user_name, label, created_at FROM snapshots ORDER BY id DESC LIMIT 200')))
api.get('/api/diagnostics/snapshots/:id', ({ params }) => {
  const s = get('SELECT * FROM snapshots WHERE id = ?', id(params.id))
  if (!s) throw new HttpError(404, 'Snapshot nicht gefunden')
  return { ...s, data: parseJson(s.data, {}) }
})
api.delete('/api/diagnostics/snapshots/:id', ({ params }) => {
  run('DELETE FROM snapshots WHERE id = ?', id(params.id))
  return { ok: true }
})
api.get('/api/diagnostics/compare', ({ query }) => {
  const a = get('SELECT * FROM snapshots WHERE id = ?', id(query.a))
  const b = get('SELECT * FROM snapshots WHERE id = ?', id(query.b))
  if (!a || !b) throw new HttpError(404, 'Snapshot nicht gefunden')
  return { a: { id: a.id, label: a.label, createdAt: a.created_at }, b: { id: b.id, label: b.label, createdAt: b.created_at }, changes: deepDiff(parseJson(a.data, {}), parseJson(b.data, {})) }
})

function deepDiff(a, b, path = '', out = []) {
  if (JSON.stringify(a) === JSON.stringify(b)) return out
  const isObj = (x) => x && typeof x === 'object'
  if (isObj(a) && isObj(b) && Array.isArray(a) === Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) deepDiff(a[k], b[k], path ? `${path}.${k}` : k, out)
    return out
  }
  out.push({ path, before: a === undefined ? '(fehlt)' : a, after: b === undefined ? '(fehlt)' : b })
  return out
}

// ---- sync, settings, log ----

api.post('/api/sync', async ({ session }) => runSync({ actor: actorOf(session), reason: 'manuell' }))

api.get('/api/settings', () => ({ ...getSettings(), env: { embyUrl: config.embyUrl, apertureUrl: config.apertureUrl, apertureDb: Boolean(config.apertureDbUrl), adminPassword: Boolean(config.adminPassword) } }))
api.put('/api/settings', ({ body, session }) => {
  const allowed = ['dryRun', 'syncIntervalMinutes', 'apertureNamePattern', 'apertureTypeMovies', 'apertureTypeSeries', 'autoGrantAperture', 'defaultLibraryGroupId', 'defaultLayoutGroupId', 'defaultUnratedTypes', 'backupsPerUser']
  const patch = Object.fromEntries(Object.entries(body).filter(([k]) => allowed.includes(k)))
  if ('syncIntervalMinutes' in patch) patch.syncIntervalMinutes = Math.max(5, Number(patch.syncIntervalMinutes) || 60)
  if ('backupsPerUser' in patch) patch.backupsPerUser = Math.max(1, Number(patch.backupsPerUser) || 15)
  for (const k of ['defaultLibraryGroupId', 'defaultLayoutGroupId']) if (k in patch) patch[k] = patch[k] ? Number(patch[k]) : null
  const s = setSettings(patch)
  invalidateState()
  logChange({ actor: actorOf(session), action: 'settings.update', target: 'Einstellungen', summary: Object.keys(patch).join(', ') })
  return s
})

api.get('/api/log', ({ query }) => listChanges({ limit: Math.min(500, Number(query.limit) || 200), offset: Number(query.offset) || 0, action: query.action || '' }))
