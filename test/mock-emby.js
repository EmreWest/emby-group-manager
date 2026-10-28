// In-memory stand-in for Emby 4.10 with the behaviour the app relies on (see docs/EMBY-API.md):
// - a user without stored home sections gets legacy defaults (Ids = section type) from GET ?IsEditMode=true
// - the first POST to /HomeSections stores those defaults first (EnsureSavedSections), with fresh ids
// - POST /HomeSections appends and assigns the Id itself
// - POST /Users/{id}/Policy replaces the whole policy
// - item counts as a user honour library access and MaxParentalRating

import http from 'node:http'
import crypto from 'node:crypto'

const gid = () => crypto.randomUUID().replace(/-/g, '')

export function createMockState() {
  const folder = (name, type, location) => ({ Name: name, CollectionType: type, Locations: [location], ItemId: String(Math.floor(Math.random() * 1e6)), Id: String(Math.floor(Math.random() * 1e6)), Guid: gid() })
  const users = []
  const addUser = (name, { admin = false, all = false } = {}) => {
    const u = {
      Id: gid(), Name: name,
      Policy: { IsAdministrator: admin, IsDisabled: false, EnableAllFolders: all, EnabledFolders: [], MaxParentalRating: null, BlockUnratedItems: [], BlockedTags: [], EnableRemoteAccess: true, SimultaneousStreamLimit: 3, KeepMe: 'unverändert' },
      Configuration: { OrderedViews: [], MyMediaExcludes: [], LatestItemsExcludes: [], HidePlayedInLatest: false, AudioLanguagePreference: 'ger' },
    }
    users.push(u)
    return u
  }
  const admin = addUser('Admin', { admin: true, all: true })
  const emre = addUser('Emre')
  const kind = addUser('Lina')
  const movies = folder('Filme', 'movies', '/media/movies')
  const series = folder('Serien', 'tvshows', '/media/tv')
  const kids = folder('Kinderfilme', 'movies', '/media/kids')
  const apEmre = folder('Für dich ausgewählt Emre Filme', 'movies', `/strm/aperture/Emre_${emre.Id}`)
  const apEmreTv = folder('Für dich ausgewählt Emre Serien', 'tvshows', `/strm/aperture-tv/Emre_${emre.Id}`)
  const apLina = folder('Für dich ausgewählt – Lina – Filme', 'movies', '/strm/elsewhere/lina')
  const apGhost = folder('Für dich ausgewählt Gast Filme', 'movies', '/strm/elsewhere/ghost')
  const folders = [movies, series, kids, apEmre, apEmreTv, apLina, apGhost]
  const collections = [
    { Id: 'c1', Name: 'Marvel', items: [12, 12, 16, 12] },
    { Id: 'c2', Name: 'Pixar', items: [0, 0, 6] },
    { Id: 'c3', Name: 'Horror Klassiker', items: [18, 18, 16] },
    { Id: 'c4', Name: 'Leer', items: [] },
    { Id: 'c5', Name: 'Weihnachten', items: [0, 6, 12] },
  ]
  return { users, folders, collections, addUser, admin, emre, kind, movies, series, kids, apEmre, apEmreTv, apLina, apGhost, homeSections: new Map(), userSettings: new Map(), passwords: { Admin: 'pw', Emre: 'pw2' }, calls: [] }
}

const LEGACY = ['smalllibrarytiles', 'resume', 'resumeaudio', 'onnow', 'latestmediablock']

function legacy(u) {
  return LEGACY.map((t) => ({ Id: t, SectionType: t === 'smalllibrarytiles' ? 'userviews' : t, Name: t, ExcludedFolders: [], ItemTypes: [] }))
}

export function startMockEmby(state = createMockState(), apiKey = 'testkey') {
  const userById = (id) => state.users.find((u) => u.Id === id)
  const views = (u) => {
    const p = u.Policy
    const vs = state.folders.filter((f) => p.EnableAllFolders || p.EnabledFolders.includes(f.Guid)).map((f) => ({ Id: f.ItemId, Guid: f.Guid, Name: f.Name, CollectionType: f.CollectionType }))
    vs.push({ Id: 'livetv1', Guid: 'aaaabbbbccccddddeeeeffff00001111', Name: 'Live TV', CollectionType: 'livetv' })
    const order = u.Configuration.OrderedViews || []
    return vs.sort((a, b) => (order.indexOf(a.Guid) + 1 || 999) - (order.indexOf(b.Guid) + 1 || 999))
  }
  const sections = (u) => state.homeSections.get(u.Id)
  const ensureSaved = (u) => {
    if (!sections(u)) state.homeSections.set(u.Id, legacy(u).map((s) => ({ ...s, Id: gid() })))
    return sections(u)
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const p = url.pathname
    let body = ''
    for await (const c of req) body += c
    const json = body ? JSON.parse(body) : null
    state.calls.push(`${req.method} ${p}`)
    const send = (code, data) => {
      res.writeHead(code, { 'Content-Type': 'application/json' })
      res.end(data === undefined ? '' : JSON.stringify(data))
    }
    if (p === '/Users/AuthenticateByName' && req.method === 'POST') {
      const u = state.users.find((x) => x.Name === json.Username)
      if (!u || state.passwords[u.Name] !== json.Pw) return send(401, { error: 'bad' })
      return send(200, { AccessToken: 'tok', User: u })
    }
    if (p === '/Sessions/Logout') return send(204)
    // Aperture API (same port for simplicity): only Lina's library is known to Aperture
    if (p.startsWith('/api/')) {
      if (p === '/api/version') return send(200, { version: '0.7.10' })
      if (req.headers['x-api-key'] !== 'apt_test') return send(401, { error: 'Unauthorized' })
      if (p === '/api/users') return send(200, { users: [{ id: 'ap-1', provider_user_id: state.kind.Id, username: 'Lina' }], total: 1 })
      if (p === '/api/settings/strm-libraries') return send(200, { libraries: [{ id: 'l1', userId: 'ap-1', channelId: null, name: state.apLina.Name, providerLibraryId: state.apLina.ItemId, isActive: true, mediaType: 'movies' }] })
      return send(404)
    }
    if (req.headers['x-emby-token'] !== apiKey) return send(401, { error: 'no key' })

    let m
    if (p === '/System/Info') return send(200, { ServerName: 'Mock', Version: '4.10.2.0' })
    if (p === '/Users/Query') return send(200, { Items: state.users, TotalRecordCount: state.users.length })
    if ((m = /^\/Users\/(\w+)$/.exec(p)) && req.method === 'GET') return userById(m[1]) ? send(200, userById(m[1])) : send(404)
    if ((m = /^\/Users\/(\w+)\/Policy$/.exec(p))) {
      userById(m[1]).Policy = json
      return send(204)
    }
    if ((m = /^\/Users\/(\w+)\/Configuration\/Partial$/.exec(p))) {
      Object.assign(userById(m[1]).Configuration, json)
      return send(204)
    }
    if (p === '/Library/VirtualFolders') return send(200, state.folders)
    if (p === '/Localization/ParentalRatings') return send(200, [{ Name: 'FSK-0', Value: 0 }, { Name: 'FSK-6', Value: 6 }, { Name: 'FSK-12', Value: 12 }, { Name: 'PG-13', Value: 12 }, { Name: 'FSK-16', Value: 16 }, { Name: 'FSK-18', Value: 18 }])
    if ((m = /^\/Users\/(\w+)\/Views$/.exec(p))) return send(200, { Items: views(userById(m[1])) })
    if ((m = /^(?:\/Users\/(\w+))?\/Items$/.exec(p))) {
      const u = m[1] ? userById(m[1]) : null
      const max = u?.Policy.MaxParentalRating
      const visible = (items) => items.filter((r) => max == null || r <= max)
      if (url.searchParams.get('IncludeItemTypes') === 'BoxSet') return send(200, { Items: state.collections.map((c) => ({ Id: c.Id, Name: c.Name, Type: 'BoxSet', ChildCount: c.items.length })) })
      const c = state.collections.find((x) => x.Id === url.searchParams.get('ParentId'))
      return send(200, { Items: [], TotalRecordCount: c ? visible(c.items).length : 0 })
    }
    if ((m = /^\/Users\/(\w+)\/HomeSections$/.exec(p))) {
      const u = userById(m[1])
      if (req.method === 'GET') return send(200, sections(u) || legacy(u))
      const list = ensureSaved(u)
      if (json.Id) Object.assign(list.find((s) => s.Id === json.Id), json)
      else list.push({ ...json, Id: gid(), Name: json.CustomName || json.SectionType })
      return send(204)
    }
    if ((m = /^\/Users\/(\w+)\/HomeSections\/Delete$/.exec(p))) {
      const u = userById(m[1])
      state.homeSections.set(u.Id, ensureSaved(u).filter((s) => !json.Ids.includes(s.Id)))
      return send(204)
    }
    if ((m = /^\/Users\/(\w+)\/HomeSections\/Move$/.exec(p))) {
      const list = ensureSaved(userById(m[1]))
      const moving = list.filter((s) => json.Ids.includes(s.Id))
      const rest = list.filter((s) => !json.Ids.includes(s.Id))
      rest.splice(json.NewIndex, 0, ...moving)
      state.homeSections.set(m[1], rest)
      return send(204)
    }
    if ((m = /^\/Users\/(\w+)\/Sections\/([^/]+)\/Items$/.exec(p))) {
      // resume rows: 2 items in progress unless every video library is excluded (as GetResumeItems does)
      const s = (sections(userById(m[1])) || legacy(userById(m[1]))).find((x) => x.Id === decodeURIComponent(m[2]))
      if (!s) return send(500, { error: 'section not found' })
      const visible = views(userById(m[1])).filter((v) => ['movies', 'tvshows'].includes(v.CollectionType) && !(s.ExcludedFolders || []).includes(v.Id))
      return send(200, { Items: [], TotalRecordCount: s.SectionType === 'resume' ? (visible.length ? 2 : 0) : 5 })
    }
    if ((m = /^\/UserSettings\/(\w+)$/.exec(p))) return send(200, state.userSettings.get(m[1]) || {})
    if ((m = /^\/UserSettings\/(\w+)\/Partial$/.exec(p))) {
      const cur = state.userSettings.get(m[1]) || {}
      for (const [k, v] of Object.entries(json)) v === null ? delete cur[k] : (cur[k] = v)
      state.userSettings.set(m[1], cur)
      return send(204)
    }
    if (p === '/UltimateCollections/Status') {
      return send(200, { Collections: [
        { Name: 'Weihnachten', Season: 'Dec 1 – Dec 26', InEmby: true, Label: 'In season', Active: true, Titles: 3 },
        { Name: 'Halloween', Season: 'Oct 1 – Oct 31', InEmby: false, Label: 'From Oct 1', Active: false, Titles: 0 },
      ] })
    }
    send(404, { error: `mock: ${req.method} ${p}` })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ state, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })))
}
