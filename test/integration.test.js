// End to end: the real server process against the mock Emby.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startMockEmby } from './mock-emby.js'

let mock
let proc
let base
let cookie = ''

async function call(method, p, body) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'egm', cookie }, body: body === undefined ? undefined : JSON.stringify(body) })
  const data = await res.json()
  if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${data.error}`)
  const set = res.headers.get('set-cookie')
  if (set) cookie = set.split(';')[0]
  return data
}

before(async () => {
  mock = await startMockEmby()
  const port = 18000 + Math.floor(Math.random() * 1000)
  base = `http://127.0.0.1:${port}`
  proc = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(port), DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'egm-it-')), EMBY_URL: mock.url, EMBY_API_KEY: 'testkey', APERTURE_URL: mock.url, APERTURE_API_KEY: 'apt_test', ADMIN_PASSWORD: 'secret', SYNC_INTERVAL_MINUTES: '600' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc.stderr.on('data', (d) => process.env.DEBUG && process.stderr.write(d))
  proc.stdout.on('data', (d) => process.env.DEBUG && process.stdout.write(d))
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(base + '/health')).ok) break
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
})

after(() => {
  proc?.kill()
  mock?.close()
})

test('login: local admin and Emby admin, non-admin refused', async () => {
  await assert.rejects(call('GET', '/api/status'), /401/)
  await assert.rejects(call('POST', '/api/auth/login', { username: 'Emre', password: 'pw2' }), /Administratoren/)
  await call('POST', '/api/auth/login', { username: 'Admin', password: 'pw' })
  await call('POST', '/api/auth/login', { username: 'admin', password: 'secret' })
  const s = await call('GET', '/api/status')
  assert.equal(s.emby.ok, true)
  assert.equal(s.emby.version, '4.10.2.0')
})

test('aperture: API first, then folder path, unassignable library flagged', async () => {
  const { libraries, method } = await call('GET', '/api/libraries')
  const by = (n) => libraries.find((l) => l.name === n)
  assert.equal(method, 'api')
  assert.equal(by('Für dich ausgewählt – Lina – Filme').aperture.method, 'api')
  assert.equal(by('Für dich ausgewählt – Lina – Filme').aperture.ownerName, 'Lina')
  assert.equal(by('Für dich ausgewählt Emre Filme').aperture.ownerName, 'Emre')
  assert.equal(by('Für dich ausgewählt Emre Filme').aperture.method, 'path')
  assert.equal(by('Für dich ausgewählt Emre Serien').aperture.mediaType, 'series')
  const matches = await call('POST', '/api/aperture/test-pattern', {})
  assert.ok(matches.some((m) => m.library === 'Für dich ausgewählt – Lina – Filme' && m.user === 'Lina'), 'pattern fallback also matches')
  const status = await call('GET', '/api/status')
  assert.equal(status.aperture.version, '0.7.10')
  assert.equal(by('Für dich ausgewählt Gast Filme').aperture.ownerId, null)
  assert.equal(by('Filme').aperture, null)
})

test('library groups: union of libraries, strictest rating, own aperture only, other policy fields untouched', async () => {
  const st = mock.state
  const fam = await call('POST', '/api/library-groups', { name: 'Familie', userIds: [st.emre.Id, st.kind.Id], libraryGuids: [st.movies.Guid, st.series.Guid, st.apLina.Guid], maxParentalRating: 16 })
  await call('POST', '/api/library-groups', { name: 'Kinder', isKids: true, userIds: [st.kind.Id], libraryGuids: [st.kids.Guid], maxParentalRating: 6, blockUnrated: ['Movie'], blockedTags: ['Horror'] })
  const pv = await call('GET', '/api/policy/preview')
  assert.ok(pv.find((u) => u.userName === 'Lina').changes.length > 0)
  assert.equal(pv.find((u) => u.userName === 'Admin').managed, false)

  const r = await call('POST', '/api/policy/apply', {})
  assert.ok(r.results.some((x) => x.user === 'Emre' && x.changed))
  const emre = st.users.find((u) => u.Name === 'Emre').Policy
  assert.deepEqual(new Set(emre.EnabledFolders), new Set([st.movies.Guid, st.series.Guid, st.apEmre.Guid, st.apEmreTv.Guid]))
  assert.equal(emre.MaxParentalRating, 16)
  assert.equal(emre.EnableAllFolders, false)
  assert.equal(emre.KeepMe, 'unverändert')
  assert.equal(emre.SimultaneousStreamLimit, 3)
  const lina = st.users.find((u) => u.Name === 'Lina').Policy
  assert.equal(lina.MaxParentalRating, 6, 'strictest rating wins')
  assert.ok(lina.EnabledFolders.includes(st.apLina.Guid), 'own aperture library')
  assert.ok(!lina.EnabledFolders.includes(st.apEmre.Guid), 'never another user’s')
  assert.deepEqual(lina.BlockedTags, ['Horror'])
  assert.deepEqual(lina.BlockUnratedItems, ['Movie'])

  const again = await call('GET', `/api/policy/preview?groupId=${fam.id}`)
  assert.ok(again.every((u) => u.changes.length === 0), 'idempotent')

  const users = await call('GET', '/api/users')
  assert.equal(users.find((u) => u.name === 'Lina').isKids, true)
})

let templateId
let layoutId

test('templates: apply to a user with only legacy defaults, order and aperture placeholder resolved', async () => {
  const st = mock.state
  const t = await call('POST', '/api/templates', {
    name: 'Familie',
    config: {
      rows: [
        { kind: 'section', sectionType: 'userviews' },
        { kind: 'section', sectionType: 'resume' },
        { kind: 'aperture', mediaType: 'movies' },
        { kind: 'seasonal', collectionName: 'Weihnachten', season: { from: '01-01', to: '12-31' } },
        { kind: 'rotation', sortBy: 'Random' },
        { kind: 'rotation' },
        { kind: 'collection', collectionId: 'c4' },
        { kind: 'section', sectionType: 'latestmediablock', libraries: { mode: 'except', guids: ['@aperture:movies'] } },
      ],
      libraryOrder: ['@aperture:movies', st.series.Guid],
      myMediaHidden: ['@aperture:series'],
      landing: { [st.movies.Guid]: 'suggestions' },
      rotation: { enabled: true, interval: 'daily', time: '04:00', avoidLastN: 1, minVisibleRatio: 0.5, pool: [{ collectionId: 'c1', weight: 2 }, { collectionId: 'c2' }, { collectionId: 'c3' }, { collectionId: 'c4' }] },
    },
  })
  templateId = t.id
  const lg = await call('POST', '/api/layout-groups', { name: 'Familie', templateId: t.id, userIds: [st.emre.Id, st.kind.Id] })
  layoutId = lg.id

  const pv = await call('GET', `/api/layout-groups/${lg.id}/preview`)
  assert.equal(pv.users.find((u) => u.user === 'Emre').legacy, true)

  const r = await call('POST', `/api/layout-groups/${lg.id}/apply`, {})
  assert.deepEqual(r.results.map((x) => x.status), ['applied', 'applied'], JSON.stringify(r))

  const emreRows = st.homeSections.get(st.emre.Id)
  assert.deepEqual(emreRows.map((s) => s.SectionType), ['userviews', 'resume', 'items', 'boxset', 'boxset', 'boxset', 'latestmediablock'], 'empty collection row dropped, legacy defaults gone')
  const ap = emreRows[2]
  assert.equal(ap.CustomName, 'Für dich ausgewählt Emre Filme')
  assert.deepEqual(ap.ExcludedFolders.sort(), st.users.find((u) => u.Name === 'Emre').Policy.EnabledFolders.filter((g) => g !== st.apEmre.Guid).map((g) => st.folders.find((f) => f.Guid === g).ItemId).concat('livetv1').sort(), 'everything but the own Aperture library, Live TV included')
  assert.equal(emreRows[3].ParentId, 'c5', 'seasonal row shown')
  assert.equal(emreRows[4].SortBy, 'Random')
  assert.ok(emreRows[6].ExcludedFolders.includes(st.apEmre.ItemId))
  const cfg = st.users.find((u) => u.Name === 'Emre').Configuration
  assert.equal(cfg.OrderedViews[0], st.apEmre.Guid)
  assert.deepEqual(cfg.MyMediaExcludes, [], 'invisible Emby list is cleared')
  assert.deepEqual(emreRows[0].ExcludedFolders, [], 'old template-wide "hide in Meine Medien" list is dropped, the row shows everything')
  const saved = await call('GET', `/api/templates/${t.id}`)
  assert.deepEqual(saved.config.rows[0].libraries, { mode: 'all', guids: [] })
  assert.equal(saved.config.myMediaHidden, undefined)
  assert.equal(cfg.AudioLanguagePreference, 'ger', 'other configuration untouched')
  assert.equal(st.userSettings.get(st.emre.Id)[`landing-${st.movies.Guid}`], 'suggestions')

  // Lina (FSK 6) must not get Horror (FSK 16/18) or Marvel (mostly 12) in rotation slots
  const linaRows = st.homeSections.get(st.kind.Id)
  const linaBoxsets = linaRows.filter((s) => s.SectionType === 'boxset').map((s) => s.ParentId)
  assert.ok(!linaBoxsets.includes('c3') && !linaBoxsets.includes('c1'), JSON.stringify(linaBoxsets))
  assert.ok(linaBoxsets.includes('c2'))

  const again = await call('POST', `/api/layout-groups/${lg.id}/apply`, {})
  assert.deepEqual(again.results.map((x) => x.status), ['unchanged', 'unchanged'])
})

test('hiding libraries in "Neu hinzugefügt" does not empty Weiterschauen; user page shows item counts', async () => {
  const st = mock.state
  const t = await call('GET', `/api/templates/${templateId}`)
  t.config.rows.find((r) => r.sectionType === 'latestmediablock').libraries = { mode: 'except', guids: [st.movies.Guid, st.series.Guid, st.kids.Guid, '@aperture:movies', '@aperture:series'] }
  await call('PUT', `/api/templates/${templateId}`, t)
  await call('POST', `/api/layout-groups/${layoutId}/apply`, { force: true })
  const rows = st.homeSections.get(st.emre.Id)
  assert.deepEqual(rows.find((s) => s.SectionType === 'resume').ExcludedFolders, [])
  assert.ok(rows.find((s) => s.SectionType === 'latestmediablock').ExcludedFolders.includes(st.movies.ItemId))
  const detail = await call('GET', `/api/users/${st.emre.Id}`)
  assert.equal(detail.homescreen.rows.find((r) => r.type === 'resume').items, 2)
  assert.equal(detail.homescreen.rows.find((r) => r.type === 'latestmediablock').items, null)

  // Live TV is a view, not a library: it can be hidden per row and gets the fixed landing key
  const t2 = await call('GET', `/api/templates/${templateId}`)
  t2.config.rows.find((r) => r.sectionType === 'latestmediablock').libraries = { mode: 'except', guids: ['@aperture:movies'] }
  t2.config.rows.find((r) => r.kind === 'section' && r.sectionType === 'userviews').libraries = { mode: 'except', guids: ['@type:livetv'] }
  t2.config.landing = { '@type:livetv': 'guide' }
  await call('PUT', `/api/templates/${templateId}`, t2)
  await call('POST', `/api/layout-groups/${layoutId}/apply`, {})
  const after = st.homeSections.get(st.emre.Id)
  assert.deepEqual(after.find((s) => s.SectionType === 'userviews').ExcludedFolders, ['livetv1'])
  assert.deepEqual(after.find((s) => s.SectionType === 'latestmediablock').ExcludedFolders.filter((x) => x !== st.apEmre.ItemId), [])
  assert.equal(st.userSettings.get(st.emre.Id)['landing-livetv'], 'guide')
})

test('row library filter "only": shown libraries stay, everything else (incl. Live TV) is excluded', async () => {
  const st = mock.state
  const t = await call('GET', `/api/templates/${templateId}`)
  t.config.rows.find((r) => r.kind === 'section' && r.sectionType === 'userviews').libraries = { mode: 'only', guids: [st.movies.Guid, st.series.Guid, '@aperture:movies'] }
  await call('PUT', `/api/templates/${templateId}`, t)
  await call('POST', `/api/layout-groups/${layoutId}/apply`, {})
  const ex = st.homeSections.get(st.emre.Id).find((s) => s.SectionType === 'userviews').ExcludedFolders
  assert.ok(ex.includes('livetv1') && ex.includes(st.apEmreTv.ItemId))
  assert.ok(!ex.includes(st.movies.ItemId) && !ex.includes(st.series.ItemId) && !ex.includes(st.apEmre.ItemId))
  t.config.rows.find((r) => r.kind === 'section' && r.sectionType === 'userviews').libraries = { mode: 'all', guids: [] }
  await call('PUT', `/api/templates/${templateId}`, t)
})

test('preview for tomorrow / next week and reroll', async () => {
  const st = mock.state
  for (const when of ['today', 'tomorrow', 'nextweek']) {
    const p = await call('POST', `/api/templates/${templateId}/preview`, { when, userId: st.emre.Id })
    assert.equal(p.rows.filter((r) => r.kind === 'rotation' && r.shown).length, 2, when)
  }
  const forEmre = await call('POST', `/api/templates/${templateId}/preview`, { when: 'today', userId: st.emre.Id })
  const mmRow = forEmre.rows.find((r) => r.label === 'Meine Medien')
  assert.equal(mmRow.libraries.length, mmRow.librariesTotal, 'preview says which libraries Meine Medien shows')
  const generic = await call('POST', `/api/templates/${templateId}/preview`, { when: 'today' })
  assert.ok(generic.rows.find((r) => r.kind === 'aperture').placeholder)

  // move the seasonal collection from a fixed row into the rotation's priority list
  const t = await call('GET', `/api/templates/${templateId}`)
  t.config.rows = t.config.rows.filter((r) => r.kind !== 'seasonal')
  t.config.rotation.seasonal = [{ collectionName: 'Weihnachten', season: { from: '01-01', to: '12-31' } }, { collectionName: 'Halloween' }]
  await call('PUT', `/api/templates/${templateId}`, t)
  const r = await call('POST', `/api/templates/${templateId}/reroll`)
  assert.equal(r.shown.length, 1, 'one slot taken by the active seasonal collection')
  assert.deepEqual(r.seasonal, ['Weihnachten'], 'Halloween is off season and not in Emby')
  const rows = st.homeSections.get(st.emre.Id).filter((s) => s.SectionType === 'boxset').map((s) => s.ParentId)
  assert.equal(rows[0], 'c5', 'seasonal collection fills the first rotation slot')
  const h = await call('GET', `/api/templates/${templateId}/history`)
  assert.ok(h.length >= 1)
})

test('backups: original kept, restore brings back the legacy rows', async () => {
  const st = mock.state
  const list = await call('GET', `/api/backups?userId=${st.emre.Id}`)
  const original = list.find((b) => b.isOriginal)
  assert.ok(original.legacy)
  await call('POST', `/api/backups/${original.id}/restore`)
  assert.deepEqual(st.homeSections.get(st.emre.Id).map((s) => s.SectionType), ['userviews', 'resume', 'resumeaudio', 'onnow', 'latestmediablock'])
})

test('hidden MyMediaExcludes: warned, taken into the row on import (stale ids dropped), cleared on apply', async () => {
  const st = mock.state
  const lina = st.users.find((u) => u.Name === 'Lina')
  lina.Configuration.MyMediaExcludes = [st.movies.Guid, 'deadbeefdeadbeefdeadbeefdeadbeef']
  const users = await call('GET', '/api/users')
  assert.ok(users.find((u) => u.name === 'Lina').warnings.some((w) => w.includes('MyMediaExcludes') && w.includes('Filme')))
  const imported = await call('POST', '/api/templates/from-user', { userId: lina.Id, name: 'Lina mit Ausblendung' })
  const mm = imported.config.rows.find((r) => r.sectionType === 'userviews')
  assert.equal(mm.libraries.mode, 'all', 'MyMediaExcludes is not taken over')
  const detail = await call('GET', `/api/users/${lina.Id}`)
  assert.deepEqual(detail.hiddenInMyMedia, ['Filme'])
  assert.ok(!JSON.stringify(imported.config).includes('deadbeef'), 'stale id dropped')
  await call('POST', `/api/layout-groups/${layoutId}/apply`, { force: true, userIds: [lina.Id] })
  assert.deepEqual(lina.Configuration.MyMediaExcludes, [])
})

test('template from user round trip', async () => {
  const st = mock.state
  const t = await call('POST', '/api/templates/from-user', { userId: st.kind.Id, name: 'Von Lina' })
  assert.ok(t.config.rows.some((r) => r.kind === 'aperture'), 'aperture row recognised')
  assert.ok(t.config.rows.some((r) => r.kind === 'collection'))
})

test('sync: new user gets default groups, rights and home screen', async () => {
  const st = mock.state
  await call('POST', '/api/sync') // first run records existing users
  const groups = await call('GET', '/api/library-groups')
  await call('PUT', '/api/settings', { defaultLibraryGroupId: groups.find((g) => g.name === 'Familie').id, defaultLayoutGroupId: layoutId })
  const neu = st.addUser('Neu')
  const r = await call('POST', '/api/sync')
  assert.deepEqual(r.newUsers, ['Neu'], JSON.stringify(r))
  assert.ok(neu.Policy.EnabledFolders.includes(st.movies.Guid))
  assert.equal(neu.Policy.EnableAllFolders, false)
  assert.ok(st.homeSections.get(neu.Id)?.length > 0)
  assert.ok(r.unassignedAperture.includes('Für dich ausgewählt Gast Filme'))
})

test('dry run: nothing is written to Emby', async () => {
  const st = mock.state
  await call('PUT', '/api/settings', { dryRun: true })
  const before = JSON.stringify(st.users.find((u) => u.Name === 'Emre').Policy)
  const g = (await call('GET', '/api/library-groups')).find((x) => x.name === 'Familie')
  await call('PUT', `/api/library-groups/${g.id}`, { ...g, maxParentalRating: 12 })
  const r = await call('POST', '/api/policy/apply', { groupId: g.id })
  assert.ok(r.dryRun)
  assert.equal(JSON.stringify(st.users.find((u) => u.Name === 'Emre').Policy), before)
  const log = await call('GET', '/api/log?action=policy')
  assert.ok(log.rows.some((x) => x.dry_run))
  await call('PUT', '/api/settings', { dryRun: false })
})

test('diagnostics: snapshot diff shows what changed', async () => {
  const st = mock.state
  const a = await call('POST', '/api/diagnostics/snapshot', { userId: st.emre.Id, label: 'vorher' })
  st.userSettings.set(st.emre.Id, { ...(st.userSettings.get(st.emre.Id) || {}), tvhome: 'horizontal' })
  const b = await call('POST', '/api/diagnostics/snapshot', { userId: st.emre.Id, label: 'nachher' })
  const d = await call('GET', `/api/diagnostics/compare?a=${a.id}&b=${b.id}`)
  assert.deepEqual(d.changes.map((c) => c.path), ['userSettings.tvhome'])
})
