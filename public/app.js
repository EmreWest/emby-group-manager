// Emby Group Manager – web UI. Plain ES module, no build step. Pages render HTML strings into #view; inputs with
// data-bind="a.b.c" write into the current page's draft object, buttons with data-action call page handlers.

const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const fmtDate = (s) => (s ? new Date(s).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '–')
const clone = (o) => JSON.parse(JSON.stringify(o))

let me = null
let meta = null
let status = null

// ---------------------------------------------------------------- api

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'egm' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    me = null
    renderLogin()
    throw new Error('Nicht angemeldet')
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}
const GET = (p) => api('GET', p)
const POST = (p, b = {}) => api('POST', p, b)
const PUT = (p, b) => api('PUT', p, b)
const DEL = (p) => api('DELETE', p)

// ---------------------------------------------------------------- ui helpers

function toast(msg, type = '') {
  const el = document.createElement('div')
  el.className = `toast ${type}`
  el.textContent = msg
  $('#toasts').append(el)
  setTimeout(() => el.remove(), type === 'error' ? 8000 : 4000)
}

// Values of the inputs (by id) of the last closed modal, read before it is removed.
let modalFields = {}

function modal(html, { wide = false } = {}) {
  return new Promise((resolve) => {
    const back = document.createElement('div')
    back.className = 'modal-back'
    back.innerHTML = `<div class="modal" style="${wide ? 'max-width:1200px' : ''}">${html}</div>`
    const close = (v) => {
      modalFields = Object.fromEntries($$('input[id],select[id],textarea[id]', back).map((el) => [el.id, el.value]))
      back.remove()
      resolve(v)
    }
    back.addEventListener('click', (e) => {
      if (e.target === back) close(null)
      const b = e.target.closest('[data-close]')
      if (b) close(b.dataset.close)
    })
    document.body.append(back)
  })
}

function confirmDialog(title, text, { ok = 'Bestätigen', danger = false } = {}) {
  return modal(`<h2>${esc(title)}</h2><div>${text}</div><div class="foot"><button data-close="">Abbrechen</button><button class="${danger ? 'danger solid' : 'primary'}" data-close="ok">${esc(ok)}</button></div>`).then((v) => v === 'ok')
}

function showJson(title, data) {
  modal(`<h2>${esc(title)}</h2><pre>${esc(JSON.stringify(data, null, 2))}</pre><div class="foot"><button data-close="">Schließen</button></div>`, { wide: true })
}

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj)
}
function setPath(obj, path, value) {
  const keys = path.split('.')
  let o = obj
  for (const k of keys.slice(0, -1)) o = o[k] ??= {}
  o[keys.at(-1)] = value
}

const opt = (value, label, current) => `<option value="${esc(value)}"${String(current ?? '') === String(value) ? ' selected' : ''}>${esc(label)}</option>`
const options = (pairs, current) => pairs.map(([v, l]) => opt(v, l, current)).join('')
const checked = (b) => (b ? ' checked' : '')

function readInput(el) {
  if (el.type === 'checkbox') {
    if (el.dataset.listValue !== undefined) return null // handled as list membership
    return el.checked
  }
  if (el.dataset.type === 'number') return el.value === '' ? null : Number(el.value)
  if (el.dataset.type === 'list') return el.value.split(',').map((s) => s.trim()).filter(Boolean)
  return el.value
}

// Generic binding: data-bind="path" sets draft[path]; checkboxes with data-list-value toggle membership in an array.
function bindInputs(root, draft, onChange) {
  const handler = (e) => {
    const el = e.target.closest('[data-bind]')
    if (!el) return
    const path = el.dataset.bind
    if (el.type === 'checkbox' && el.dataset.listValue !== undefined) {
      const arr = new Set(getPath(draft, path) || [])
      el.checked ? arr.add(el.dataset.listValue) : arr.delete(el.dataset.listValue)
      setPath(draft, path, [...arr])
    } else {
      setPath(draft, path, readInput(el))
    }
    if (onChange) onChange(el, e.type)
  }
  root.addEventListener('change', handler)
  root.addEventListener('input', (e) => e.target.matches('input[type=text],input:not([type]),textarea,input[type=number]') && handler(e))
}

function onActions(root, actions) {
  root.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]')
    if (!el || !root.contains(el)) return
    const fn = actions[el.dataset.action]
    if (!fn) return
    e.preventDefault()
    el.disabled = true
    try {
      await fn(el.dataset, el)
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      el.disabled = false
    }
  })
}

const badge = (text, cls = '') => `<span class="badge ${cls}">${esc(text)}</span>`

// "Alle" / "Keine" for a .checklist (placed inside it) or, with `col`, for one checkbox column of a table.
const checkTools = (col = '', [allLabel, noneLabel] = ['Alle', 'Keine']) =>
  `<span class="check-tools"><button type="button" class="small" data-check="all"${col ? ` data-col="${esc(col)}"` : ''}>${allLabel}</button><button type="button" class="small" data-check="none"${col ? ` data-col="${esc(col)}"` : ''}>${noneLabel}</button></span>`

// Ticks each box like a click would, so the page's data-bind handlers update the draft.
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-check]')
  if (!b) return
  e.preventDefault()
  const on = b.dataset.check === 'all'
  const scope = b.closest(b.dataset.col ? 'table' : '.checklist')
  const boxes = $$(b.dataset.col ? 'input[type=checkbox][data-bind]' : 'input[type=checkbox]', scope).filter((c) => !b.dataset.col || c.dataset.bind === b.dataset.col)
  for (const c of boxes) {
    if (c.disabled || c.checked === on) continue
    c.checked = on
    c.dispatchEvent(new Event('change', { bubbles: true }))
  }
})

// ---------------------------------------------------------------- constants

const SORTS = [
  ['', 'Standard'], ['Random', 'Zufällig (bei jedem Aufruf neu)'], ['SortName', 'Titel'], ['DateCreated', 'Hinzugefügt am'],
  ['PremiereDate', 'Erscheinungsdatum'], ['ProductionYear', 'Jahr'], ['CommunityRating', 'Bewertung'], ['CriticRating', 'Kritikerbewertung'],
  ['Runtime', 'Laufzeit'], ['DatePlayed', 'Zuletzt gesehen'], ['DateLastContentAdded,SortName', 'Zuletzt Inhalt hinzugefügt'],
]
const COLLECTION_SORTS = [
  ['', 'Standard'], ['default', 'Reihenfolge der Kollektion'], ['Random', 'Zufällig ⚠ (siehe Hinweis)'], ['SortName', 'Titel'],
  ['DateCreated', 'Hinzugefügt am'], ['ProductionYear', 'Jahr'], ['CommunityRating', 'Bewertung'], ['Runtime', 'Laufzeit'],
]
const ORDERS = [['', 'Standard'], ['Ascending', 'Aufsteigend'], ['Descending', 'Absteigend']]
const DISPLAY_MODES = [['', 'Alle Geräte'], ['tv', 'Nur TV'], ['mobile,desktop', 'Nur Mobil & Desktop']]
const IMAGE_TYPES = [['', 'Standard'], ['Primary', 'Poster'], ['Thumb', 'Vorschaubild']]
const SCROLL = [['', 'Standard'], ['Horizontal', 'Horizontal'], ['Vertical', 'Vertikal']]
const KIND_LABELS = { section: 'Emby-Zeile', aperture: 'Aperture', collection: 'Kollektion', seasonal: 'Saisonal', rotation: 'Rotation' }
const KIND_BADGE = { section: '', aperture: 'info', collection: 'ok', seasonal: 'warn', rotation: 'kids' }
const UNRATED_LABELS = { Movie: 'Filme', Series: 'Serien', Trailer: 'Trailer', Music: 'Musik', Book: 'Bücher', Game: 'Spiele', LiveTvChannel: 'Live-TV-Kanäle', LiveTvProgram: 'Live-TV-Sendungen', ChannelContent: 'Kanalinhalte', Other: 'Sonstiges' }
const ITEM_TYPE_LABELS = { Movie: 'Filme', Series: 'Serien', 'Movie,Series': 'Filme & Serien', Episode: 'Episoden', MusicVideo: 'Musikvideos', Video: 'Videos', Trailer: 'Trailer', Audio: 'Musik', MusicAlbum: 'Alben', Book: 'Bücher' }
const LANDING = {
  movies: [['', 'Filme'], ['suggestions', 'Vorschläge'], ['favorites', 'Favoriten'], ['genres', 'Genres'], ['collections', 'Kollektionen'], ['tags', 'Tags'], ['folders', 'Ordner']],
  tvshows: [['', 'Serien'], ['suggestions', 'Vorschläge'], ['favorites', 'Favoriten'], ['collections', 'Kollektionen'], ['genres', 'Genres'], ['tags', 'Tags'], ['studios', 'Sender'], ['folders', 'Ordner']],
  music: [['', 'Vorschläge'], ['albums', 'Alben'], ['albumartists', 'Album-Interpreten'], ['artists', 'Interpreten'], ['playlists', 'Wiedergabelisten'], ['genres', 'Genres'], ['songs', 'Titel'], ['folders', 'Ordner']],
  livetv: [['', 'Vorschläge'], ['guide', 'TV-Programm'], ['channels', 'Kanäle'], ['tags', 'Tags'], ['recordings', 'Aufnahmen'], ['schedule', 'Zeitplan'], ['series', 'Serien']],
}
// Views that are not libraries; the server matches them by type (see matchViews in server/homescreen.js).
const SPECIAL_VIEWS = [['@type:livetv', 'Live TV'], ['@type:boxsets', 'Kollektionen'], ['@type:playlists', 'Wiedergabelisten']]
// Is library token v shown in a row with this library filter?
const libShown = (lib, v) => (lib.mode === 'all' ? true : lib.mode === 'except' ? !lib.guids.includes(v) : lib.guids.includes(v))
const WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag']
const APERTURE_TOKENS = [['@aperture:movies', 'Eigene Aperture-Filme (Platzhalter)'], ['@aperture:series', 'Eigene Aperture-Serien (Platzhalter)']]

// ---------------------------------------------------------------- shell & routing

const NAV = [
  ['', 'Übersicht'], ['benutzer', 'Benutzer'], ['bibliotheken', 'Bibliotheken & Aperture'], ['-'],
  ['gruppen', 'Bibliotheksgruppen'], ['-'],
  ['vorlagen', 'Homescreen-Vorlagen'], ['layouts', 'Layout-Gruppen'], ['-'],
  ['backups', 'Backups'], ['diagnose', 'Diagnose'], ['protokoll', 'Protokoll'], ['einstellungen', 'Einstellungen'],
]

function renderShell() {
  const route = location.hash.replace(/^#\/?/, '').split('/')[0]
  $('#app').innerHTML = `
    <div class="layout">
      <nav class="side">
        <div class="brand"><img src="favicon.svg" alt=""> Emby Group Manager</div>
        ${NAV.map(([k, l]) => (k === '-' ? '<div class="sep"></div>' : `<a href="#/${k}" class="${route === k ? 'active' : ''}">${l}</a>`)).join('')}
        <div class="foot">Angemeldet als <b>${esc(me.name)}</b><br><a href="#" id="logout">Abmelden</a></div>
      </nav>
      <div>
        ${status?.dryRun ? '<div class="dry-banner">Dry-Run aktiv: Änderungen werden nur protokolliert, nicht an Emby gesendet.</div>' : ''}
        <main id="view"><div class="muted">Lade …</div></main>
      </div>
    </div>`
  $('#logout').onclick = async (e) => {
    e.preventDefault()
    await POST('/api/auth/logout')
    me = null
    renderLogin()
  }
}

const ROUTES = {
  '': pageDashboard,
  benutzer: pageUsers,
  bibliotheken: pageLibraries,
  gruppen: pageLibraryGroups,
  vorlagen: pageTemplates,
  layouts: pageLayoutGroups,
  backups: pageBackups,
  diagnose: pageDiagnostics,
  protokoll: pageLog,
  einstellungen: pageSettings,
}

async function route() {
  if (!me) return
  const [name, ...args] = location.hash.replace(/^#\/?/, '').split('/')
  renderShell()
  const view = $('#view')
  try {
    await (ROUTES[name] || pageDashboard)(view, ...args.map(decodeURIComponent))
  } catch (e) {
    view.innerHTML = `<div class="alert danger">${esc(e.message)}</div>`
  }
}

function renderLogin(error = '') {
  $('#app').innerHTML = `
    <div class="login">
      <div class="card">
        <h1>Emby Group Manager</h1>
        <p class="muted">Anmeldung mit einem Emby-Administratorkonto${meta?.methods?.password ? ' oder dem lokalen Admin-Passwort' : ''}.</p>
        ${error ? `<div class="alert danger">${esc(error)}</div>` : ''}
        <form id="login-form">
          <label class="field"><span>Benutzername</span><input name="username" autocomplete="username" required autofocus></label>
          <label class="field"><span>Passwort</span><input name="password" type="password" autocomplete="current-password" required></label>
          <button class="primary" type="submit" style="width:100%;justify-content:center">Anmelden</button>
        </form>
      </div>
    </div>`
  $('#login-form').onsubmit = async (e) => {
    e.preventDefault()
    const f = new FormData(e.target)
    try {
      const r = await POST('/api/auth/login', { username: f.get('username'), password: f.get('password') })
      me = r.user
      await boot()
    } catch (err) {
      renderLogin(err.message)
    }
  }
}

async function boot() {
  const auth = await GET('/api/auth/me')
  meta = { methods: auth.methods }
  me = auth.user
  if (!me) return renderLogin()
  meta = { ...meta, ...(await GET('/api/meta')) }
  status = { dryRun: meta.settings.dryRun }
  route()
}

window.addEventListener('hashchange', route)
boot().catch((e) => ($('#app').innerHTML = `<div class="boot">${esc(e.message)}</div>`))

// ---------------------------------------------------------------- dashboard

async function pageDashboard(view) {
  status = await GET('/api/status')
  renderShell()
  view = $('#view')
  const s = status
  const ls = s.lastSync
  view.innerHTML = `
    <div class="page-head"><div><h1>Übersicht</h1><div class="sub">Verbindungen, Abgleich und offene Warnungen</div></div>
      <div class="actions"><button data-action="refresh">Neu laden</button><button class="primary" data-action="sync">Jetzt abgleichen</button></div></div>
    ${s.warnings.map((w) => `<div class="alert warn">${esc(w)}</div>`).join('')}
    <div class="grid cols-3">
      <div class="card"><h2>Emby</h2>
        ${s.emby.ok ? `<dl class="kv"><dt>Server</dt><dd>${esc(s.emby.serverName)}</dd><dt>Version</dt><dd>${esc(s.emby.version)}</dd><dt>URL</dt><dd>${esc(s.emby.url)}</dd></dl>` : `<div class="alert danger">${esc(s.emby.error || 'Nicht konfiguriert')}</div>`}
      </div>
      <div class="card"><h2>Aperture</h2>
        <dl class="kv">
          <dt>Version</dt><dd>${esc(s.aperture.version || 'unbekannt')} <span class="muted small">(geprüft: ${esc(s.aperture.testedVersion)})</span></dd>
          <dt>API</dt><dd>${esc(s.aperture.sources?.api || (s.aperture.url ? '–' : 'nicht konfiguriert'))}</dd>
          <dt>Datenbank</dt><dd>${esc(s.aperture.sources?.db || (s.aperture.db ? '–' : 'nicht konfiguriert'))}</dd>
          <dt>Zuordnung</dt><dd>${esc(methodLabel(s.aperture.method) || 'Ordnerpfad / Namensschema')}</dd>
        </dl>
      </div>
      <div class="card"><h2>Abgleich</h2>
        <dl class="kv">
          <dt>Intervall</dt><dd>alle ${s.syncIntervalMinutes} Min.</dd>
          <dt>Zuletzt</dt><dd>${ls ? fmtDate(ls.finishedAt) + ` (${esc(ls.reason)})` : 'noch nie'} ${s.syncRunning ? badge('läuft', 'info') : ''}</dd>
          <dt>Modus</dt><dd>${s.dryRun ? badge('Dry-Run', 'warn') : badge('Live', 'ok')}</dd>
        </dl>
        ${ls ? syncSummary(ls) : ''}
      </div>
    </div>
    ${s.counts ? `<div class="grid cols-3">
      ${[['Benutzer', s.counts.users, 'benutzer'], ['Bibliotheken', s.counts.libraries, 'bibliotheken'], ['Aperture-Bibliotheken', s.counts.aperture, 'bibliotheken'], ['Bibliotheksgruppen', s.counts.libraryGroups, 'gruppen'], ['Homescreen-Vorlagen', s.counts.templates, 'vorlagen'], ['Layout-Gruppen', s.counts.layoutGroups, 'layouts']]
        .map(([l, n, h]) => `<a class="card" href="#/${h}" style="text-decoration:none;color:inherit"><div class="muted">${l}</div><div class="stat">${n}</div></a>`).join('')}
    </div>` : ''}`
  onActions(view, {
    refresh: async () => {
      await POST('/api/refresh')
      route()
    },
    sync: async () => {
      toast('Abgleich gestartet …')
      const r = await POST('/api/sync')
      toast(r.errors.length ? `Abgleich mit ${r.errors.length} Fehler(n) beendet` : 'Abgleich beendet', r.errors.length ? 'error' : '')
      route()
    },
  })
}

function syncSummary(r) {
  const parts = [
    ['Neue Benutzer', r.newUsers], ['Freigegeben', r.granted], ['Neu gewürfelt', r.rolled], ['Homescreens', r.homescreens], ['Ohne Zuordnung', r.unassignedAperture], ['Fehler', r.errors],
  ].filter(([, v]) => v?.length)
  if (!parts.length) return '<p class="muted small">Keine Änderungen.</p>'
  return parts.map(([l, v]) => `<p class="small"><b>${l}:</b> ${v.map(esc).join(', ')}</p>`).join('')
}

const methodLabel = (m) => ({ api: 'Aperture-API', db: 'Aperture-Datenbank', path: 'Ordnerpfad', name: 'Namensschema' })[m] || m

// ---------------------------------------------------------------- users

async function pageUsers(view, userId) {
  if (userId) return pageUserDetail(view, userId)
  const users = await GET('/api/users')
  let filter = ''
  const render = () => {
    const rows = users.filter((u) => !filter || u.name.toLowerCase().includes(filter))
    $('#user-table').innerHTML = `
      <thead><tr><th>Benutzer</th><th>Bibliotheksgruppen</th><th>Layout / Vorlage</th><th>Aperture</th><th>Bibliotheken</th><th>Altersfreigabe</th><th>Hinweise</th></tr></thead>
      <tbody>${rows.map((u) => `
        <tr class="click" data-href="#/benutzer/${u.id}">
          <td><b>${esc(u.name)}</b><br>${u.isAdmin ? badge('Admin', 'info') : ''}${u.isKids ? badge('Kinderprofil', 'kids') : ''}${u.isDisabled ? badge('deaktiviert') : ''}${u.managed ? '' : badge('nicht verwaltet')}</td>
          <td>${u.libraryGroups.map((g) => badge(g.name, g.isKids ? 'kids' : '')).join('') || '<span class="muted">–</span>'}</td>
          <td>${u.layoutGroup ? esc(u.layoutGroup.name) : '<span class="muted">–</span>'}${u.template ? `<br><span class="small muted">${esc(u.template.name)} · ${fmtDate(u.template.appliedAt)}</span>` : ''}</td>
          <td>${u.aperture.map((a) => badge(a.mediaType === 'series' ? 'Serien' : 'Filme', 'info')).join('') || '<span class="muted">–</span>'}</td>
          <td>${u.allFolders ? badge('alle', 'warn') : u.folderCount}</td>
          <td>${esc(u.rating || '–')}</td>
          <td class="small">${u.warnings.map((w) => `<div class="alert warn" style="padding:4px 8px;margin:0 0 4px">${esc(w)}</div>`).join('')}</td>
        </tr>`).join('')}</tbody>`
  }
  view.innerHTML = `
    <div class="page-head"><div><h1>Benutzer</h1><div class="sub">${users.length} Emby-Benutzer · effektive Rechte aus Bibliotheksgruppen + eigene Aperture-Bibliotheken</div></div>
      <div class="actions"><input id="user-filter" placeholder="Suchen …" style="width:220px"></div></div>
    <div class="card table-wrap"><table id="user-table"></table></div>`
  render()
  $('#user-filter').oninput = (e) => {
    filter = e.target.value.toLowerCase()
    render()
  }
  view.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-href]')
    if (tr) location.hash = tr.dataset.href
  })
}

async function pageUserDetail(view, userId) {
  const u = await GET(`/api/users/${userId}`)
  const p = u.policy
  view.innerHTML = `
    <div class="page-head"><div><a href="#/benutzer">← Benutzer</a><h1>${esc(u.name)}</h1>
      <div class="sub">${u.effective.groups.map((g) => badge(g.name, g.isKids ? 'kids' : '')).join('') || 'In keiner Bibliotheksgruppe – Rechte werden nicht verwaltet'}</div></div>
      <div class="actions">
        <button data-action="snapshot">Diagnose-Snapshot</button>
        <button data-action="backup">Homescreen sichern</button>
        <button data-action="totemplate">Als Vorlage speichern</button>
      </div></div>
    <div class="grid cols-2">
      <div class="card"><h2>Rechte (Vorschau)</h2>
        ${!p.managed ? '<p class="muted">Nicht verwaltet.</p>' : p.changes.length ? changesHtml(p.changes) + '<div class="actions"><button class="primary" data-action="apply">Rechte jetzt anwenden</button></div>' : '<div class="alert ok">Emby entspricht bereits den Gruppen.</div>'}
      </div>
      <div class="card"><h2>Aktueller Homescreen</h2>
        ${u.homescreen.error ? `<div class="alert danger">${esc(u.homescreen.error)}</div>` : `
          ${u.homescreen.legacy ? '<div class="alert info">Keine gespeicherten Zeilen – Emby zeigt seine Standardwerte.</div>' : ''}
          ${u.hiddenInMyMedia.length ? `<div class="alert warn">Zusätzlich in „Meine Medien“ und im Menü versteckt (Emby-Einstellung MyMediaExcludes): ${esc(u.hiddenInMyMedia.join(', '))}. Wird beim nächsten Anwenden einer Vorlage geleert.</div>` : ''}
          <ol>${u.homescreen.rows.map((r) => `<li>${esc(r.label)} <span class="muted small">${esc(r.type)}${r.sortBy ? ' · ' + esc(r.sortBy) : ''}</span>
            ${r.excluded.length ? `<div class="small muted">ohne: ${esc(r.excluded.join(', '))}</div>` : ''}
            ${r.items == null ? '' : r.items ? badge(`${r.items} Einträge`, 'ok') : badge('leer – Emby blendet die Zeile aus', 'warn')}</li>`).join('')}</ol>
          <p class="hint">Einträge = was Emby diesem Benutzer in der Zeile gerade liefert. „Weiterschauen“ ist leer, solange nichts angefangen ist.</p>
          ${u.layoutState ? `<p class="small muted">Zuletzt von diesem Tool geschrieben: ${fmtDate(u.layoutState.applied_at)}</p>` : ''}`}
      </div>
    </div>
    <div class="card"><h2>Backups</h2>${backupTable(u.backups)}</div>`
  onActions(view, {
    apply: async () => {
      const r = await POST('/api/policy/apply', { userId })
      toast(r.dryRun ? 'Dry-Run: Änderungen protokolliert' : 'Rechte angewendet')
      route()
    },
    backup: async () => {
      const r = await POST('/api/backups', { userId })
      toast(`Backup #${r.id} angelegt`)
      route()
    },
    snapshot: async () => {
      const label = prompt('Bezeichnung für den Snapshot', 'vorher')
      if (label == null) return
      await POST('/api/diagnostics/snapshot', { userId, label })
      toast('Snapshot gespeichert – siehe Diagnose')
    },
    totemplate: async () => {
      const name = prompt('Name der neuen Vorlage', `Startseite von ${u.name}`)
      if (!name) return
      const t = await POST('/api/templates/from-user', { userId, name })
      location.hash = `#/vorlagen/${t.id}`
    },
    ...backupActions(),
  })
}

function changesHtml(changes) {
  return `<table><tbody>${changes.map((c) => `
    <tr><td class="nowrap"><b>${esc(c.label)}</b></td><td>
      ${c.added || c.removed ? `${(c.added || []).map((x) => `<div class="diff-add">+ ${esc(x)}</div>`).join('')}${(c.removed || []).map((x) => `<div class="diff-del">− ${esc(x)}</div>`).join('')}`
        : `<span class="diff-del">${esc(fmtVal(c.from))}</span> → <span class="diff-add">${esc(fmtVal(c.to))}</span>`}
    </td></tr>`).join('')}</tbody></table>`
}
const fmtVal = (v) => (Array.isArray(v) ? (v.length ? v.join(', ') : 'keine') : v)

// ---------------------------------------------------------------- libraries & aperture

async function pageLibraries(view) {
  const [{ libraries, sources, method }, settings] = await Promise.all([GET('/api/libraries'), GET('/api/settings')])
  const draft = { apertureNamePattern: settings.apertureNamePattern, apertureTypeMovies: settings.apertureTypeMovies, apertureTypeSeries: settings.apertureTypeSeries }
  const ap = libraries.filter((l) => l.aperture)
  const normal = libraries.filter((l) => !l.aperture)
  view.innerHTML = `
    <div class="page-head"><div><h1>Bibliotheken & Aperture</h1><div class="sub">Zuordnung: ${esc(methodLabel(method) || 'Ordnerpfad / Namensschema')} · API: ${esc(sources.api)} · DB: ${esc(sources.db)}</div></div></div>
    <div class="card"><h2>Aperture-Bibliotheken (${ap.length})</h2>
      <p class="muted small">Reihenfolge der Zuordnung: Aperture-API → Aperture-Datenbank → Ordnerpfad (…/aperture/Name_EmbyID) → Namensschema. Nicht zuordenbare Bibliotheken werden niemandem freigegeben.</p>
      <div class="table-wrap"><table><thead><tr><th>Bibliothek</th><th>Typ</th><th>Besitzer</th><th>Methode</th><th>Pfad</th></tr></thead><tbody>
      ${ap.map((l) => `<tr><td><b>${esc(l.name)}</b></td><td>${l.aperture.mediaType === 'series' ? 'Serien' : 'Filme'}</td>
        <td>${l.aperture.ownerName ? esc(l.aperture.ownerName) : `<span class="badge danger">nicht zugeordnet</span><div class="small muted">${esc(l.aperture.problem || '')}</div>`}</td>
        <td>${esc(methodLabel(l.aperture.method) || '–')}</td><td class="small muted">${esc(l.locations.join(', '))}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Keine gefunden.</td></tr>'}
      </tbody></table></div>
    </div>
    <div class="card"><h2>Namensschema (Fallback)</h2>
      <div class="row-fields">
        <label class="field"><span>Muster</span><input data-bind="apertureNamePattern" value="${esc(draft.apertureNamePattern)}"><small>Platzhalter {username} und {type}; Leerzeichen und Trennzeichen (- – : |) sind austauschbar.</small></label>
        <label class="field"><span>{type} für Filme</span><input data-bind="apertureTypeMovies" value="${esc(draft.apertureTypeMovies)}"></label>
        <label class="field"><span>{type} für Serien</span><input data-bind="apertureTypeSeries" value="${esc(draft.apertureTypeSeries)}"></label>
      </div>
      <div class="actions"><button data-action="test">Muster testen</button><button class="primary" data-action="save">Speichern</button></div>
      <div id="pattern-result"></div>
    </div>
    <div class="card"><h2>Weitere Bibliotheken (${normal.length})</h2>
      <div class="table-wrap"><table><thead><tr><th>Bibliothek</th><th>Typ</th><th>Gruppen</th><th>Pfad</th></tr></thead><tbody>
      ${normal.map((l) => `<tr><td><b>${esc(l.name)}</b></td><td>${esc(l.collectionType || '–')}</td><td>${l.groups.map((g) => badge(g)).join('') || '<span class="muted">–</span>'}</td><td class="small muted">${esc(l.locations.join(', '))}</td></tr>`).join('')}
      </tbody></table></div>
    </div>`
  bindInputs(view, draft)
  onActions(view, {
    test: async () => {
      const r = await POST('/api/aperture/test-pattern', { pattern: draft.apertureNamePattern, typeMovies: draft.apertureTypeMovies, typeSeries: draft.apertureTypeSeries })
      $('#pattern-result').innerHTML = r.length
        ? `<table><thead><tr><th>Bibliothek</th><th>Erkannter Name</th><th>Typ</th><th>Emby-Benutzer</th></tr></thead><tbody>${r.map((m) => `<tr><td>${esc(m.library)}</td><td>${esc(m.username)}</td><td>${esc(m.type || '–')}</td><td>${m.user ? badge(m.user, 'ok') : badge('kein Treffer', 'danger')}</td></tr>`).join('')}</tbody></table>`
        : '<div class="alert warn">Keine Bibliothek passt zum Muster.</div>'
    },
    save: async () => {
      await PUT('/api/settings', draft)
      toast('Gespeichert')
      route()
    },
  })
}

// ---------------------------------------------------------------- library groups

async function pageLibraryGroups(view, groupId) {
  if (groupId) return pageLibraryGroupEdit(view, groupId)
  const [groupsList, ratings] = await Promise.all([GET('/api/library-groups'), GET('/api/ratings')])
  const ratingName = (v) => (v == null ? 'keine' : ratings.filter((r) => r.Value <= v).pop()?.Name || v)
  view.innerHTML = `
    <div class="page-head"><div><h1>Bibliotheksgruppen</h1><div class="sub">Ein Benutzer kann in mehreren Gruppen sein: Bibliotheken werden vereinigt, die strengste Altersfreigabe gilt.</div></div>
      <div class="actions"><button data-action="previewAll">Alle: Vorschau & Anwenden</button><a class="btn primary" href="#/gruppen/neu" style="background:var(--accent);color:#fff;border-color:var(--accent)">Neue Gruppe</a></div></div>
    <div class="grid cols-3">
      ${groupsList.map((g) => `<div class="card">
        <h2>${esc(g.name)} ${g.isKids ? badge('Kinder', 'kids') : ''}</h2>
        <p class="muted">${esc(g.description || '')}</p>
        <dl class="kv"><dt>Mitglieder</dt><dd>${g.userIds.length}</dd><dt>Bibliotheken</dt><dd>${g.libraryGuids.length}</dd><dt>Altersfreigabe</dt><dd>${esc(ratingName(g.maxParentalRating))}</dd>
          ${g.blockUnrated.length ? `<dt>Ohne Freigabe</dt><dd>blockiert</dd>` : ''}${g.blockedTags.length ? `<dt>Gesperrte Tags</dt><dd>${g.blockedTags.map(esc).join(', ')}</dd>` : ''}</dl>
        <div class="actions" style="margin-top:12px"><a class="btn" href="#/gruppen/${g.id}">Bearbeiten</a><button data-action="preview" data-id="${g.id}">Vorschau & Anwenden</button></div>
      </div>`).join('') || '<div class="card muted">Noch keine Gruppen.</div>'}
    </div>`
  onActions(view, {
    preview: ({ id }) => policyPreviewDialog({ groupId: id }),
    previewAll: () => policyPreviewDialog({}),
  })
}

async function policyPreviewDialog(scope) {
  const qs = scope.groupId ? `?groupId=${scope.groupId}` : ''
  const rows = await GET(`/api/policy/preview${qs}`)
  const changed = rows.filter((r) => r.changes.length)
  const html = `<h2>Vorschau: Rechte</h2>
    ${status?.dryRun ? '<div class="alert warn">Dry-Run aktiv – es wird nur protokolliert.</div>' : ''}
    <p class="muted">${changed.length} von ${rows.filter((r) => r.managed).length} verwalteten Benutzern ändern sich. Nur die Felder Bibliotheken, Altersfreigabe, nicht bewertete Inhalte und gesperrte Tags werden geschrieben; alle anderen Policy-Felder bleiben unverändert.</p>
    ${changed.map((r) => `<h3>${esc(r.userName)} ${r.isAdmin ? badge('Admin', 'info') : ''}</h3>${changesHtml(r.changes)}`).join('') || '<div class="alert ok">Keine Änderungen nötig.</div>'}
    <div class="foot"><button data-close="">Schließen</button>${changed.length ? `<button class="primary" data-close="apply">${changed.length} Benutzer anwenden</button>` : ''}</div>`
  if ((await modal(html, { wide: true })) !== 'apply') return
  const r = await POST('/api/policy/apply', scope)
  const errors = r.results.filter((x) => x.error)
  showResults('Ergebnis', r.results.map((x) => `${x.user}: ${x.error ? 'Fehler – ' + x.error : x.changed ? (x.dryRun ? 'Dry-Run' : 'angewendet') : 'unverändert'}`))
  if (errors.length) toast(`${errors.length} Fehler`, 'error')
}

function showResults(title, lines) {
  modal(`<h2>${esc(title)}</h2><ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul><div class="foot"><button data-close="">OK</button></div>`)
}

async function pageLibraryGroupEdit(view, groupId) {
  const isNew = groupId === 'neu'
  const [g, users, { libraries }, ratings] = await Promise.all([
    isNew ? Promise.resolve({ name: '', description: '', isKids: false, maxParentalRating: null, blockUnrated: [], blockedTags: [], userIds: [], libraryGuids: [] }) : GET(`/api/library-groups`).then((l) => l.find((x) => String(x.id) === groupId)),
    GET('/api/users'), GET('/api/libraries'), GET('/api/ratings'),
  ])
  if (!g) throw new Error('Gruppe nicht gefunden')
  const draft = clone(g)
  const blockUnratedOn = draft.blockUnrated.length > 0
  view.innerHTML = `
    <div class="page-head"><div><a href="#/gruppen">← Bibliotheksgruppen</a><h1>${isNew ? 'Neue Bibliotheksgruppe' : esc(g.name)}</h1></div>
      <div class="actions">${isNew ? '' : '<button class="danger" data-action="delete">Löschen</button>'}<button data-action="savePreview">Speichern & Vorschau</button><button class="primary" data-action="save">Speichern</button></div></div>
    <div class="grid cols-2">
      <div class="card"><h2>Allgemein</h2>
        <label class="field"><span>Name</span><input data-bind="name" value="${esc(draft.name)}"></label>
        <label class="field"><span>Beschreibung</span><input data-bind="description" value="${esc(draft.description)}"></label>
        <label class="check"><input type="checkbox" data-bind="isKids"${checked(draft.isKids)}> Kinderprofil (Mitglieder werden in der Übersicht als Kinderprofil markiert)</label>
        <h3>Jugendschutz</h3>
        <label class="field"><span>Maximale Altersfreigabe</span>
          <select data-bind="maxParentalRating" data-type="number">${opt('', 'keine Beschränkung', draft.maxParentalRating ?? '')}${ratings.map((r) => opt(r.Value, r.Name, draft.maxParentalRating)).join('')}</select>
          <small>Bei mehreren Gruppen gilt die strengste. Gilt auch für die Aperture-Bibliotheken.</small></label>
        <label class="check"><input type="checkbox" id="block-unrated"${checked(blockUnratedOn)}> Nicht bewertete Inhalte blockieren</label>
        <div id="unrated-types" class="checklist" style="${blockUnratedOn ? '' : 'display:none'}">
          ${checkTools()}
          ${meta.unratedTypes.map((t) => `<label class="check"><input type="checkbox" data-bind="blockUnrated" data-list-value="${t}"${checked(draft.blockUnrated.includes(t))}> ${esc(UNRATED_LABELS[t] || t)}</label>`).join('')}
        </div>
        <label class="field" style="margin-top:12px"><span>Gesperrte Tags</span><input data-bind="blockedTags" data-type="list" value="${esc(draft.blockedTags.join(', '))}"><small>Kommagetrennt</small></label>
      </div>
      <div class="card"><h2>Bibliotheken</h2>
        <div class="checklist">${checkTools()}${libraries.filter((l) => !l.aperture).map((l) => `<label class="check"><input type="checkbox" data-bind="libraryGuids" data-list-value="${esc(l.guid)}"${checked(draft.libraryGuids.includes(l.guid))}> ${esc(l.name)}</label>`).join('')}</div>
        <p class="hint">Aperture-Bibliotheken erscheinen hier nicht: jedes Mitglied bekommt automatisch nur seine eigenen.</p>
        <h2 style="margin-top:18px">Mitglieder</h2>
        <div class="checklist">${checkTools()}${users.map((u) => `<label class="check"><input type="checkbox" data-bind="userIds" data-list-value="${esc(u.id)}"${checked(draft.userIds.includes(u.id))}> ${esc(u.name)} ${u.isAdmin ? badge('Admin', 'info') : ''}</label>`).join('')}</div>
      </div>
    </div>`
  bindInputs(view, draft)
  $('#block-unrated').onchange = (e) => {
    $('#unrated-types').style.display = e.target.checked ? '' : 'none'
    draft.blockUnrated = e.target.checked ? (meta.settings.defaultUnratedTypes || []).slice() : []
    $$('#unrated-types input').forEach((i) => (i.checked = draft.blockUnrated.includes(i.dataset.listValue)))
  }
  const save = async () => {
    const saved = isNew ? await POST('/api/library-groups', draft) : await PUT(`/api/library-groups/${groupId}`, draft)
    toast('Gespeichert – noch nicht angewendet')
    return saved
  }
  onActions(view, {
    save: async () => {
      const s = await save()
      location.hash = `#/gruppen/${s.id}`
    },
    savePreview: async () => {
      const s = await save()
      if (isNew) location.hash = `#/gruppen/${s.id}`
      await policyPreviewDialog({ groupId: s.id })
    },
    delete: async () => {
      if (!(await confirmDialog('Gruppe löschen?', `„${esc(g.name)}“ wird gelöscht. Die Rechte in Emby ändern sich erst beim nächsten Anwenden.`, { ok: 'Löschen', danger: true }))) return
      await DEL(`/api/library-groups/${groupId}`)
      location.hash = '#/gruppen'
    },
  })
}

// ---------------------------------------------------------------- templates

async function pageTemplates(view, templateId) {
  if (templateId) return pageTemplateEdit(view, templateId)
  const [list, users] = await Promise.all([GET('/api/templates'), GET('/api/users')])
  view.innerHTML = `
    <div class="page-head"><div><h1>Homescreen-Vorlagen</h1><div class="sub">Feste Zeilen, Aperture-Platzhalter, Kollektionen, saisonale Zeilen und Rotationsplätze</div></div>
      <div class="actions"><button data-action="fromUser">Aus Benutzer übernehmen</button><a class="btn" href="#/vorlagen/neu" style="background:var(--accent);color:#fff;border-color:var(--accent)">Neue Vorlage</a></div></div>
    <div class="grid cols-3">
      ${list.map((t) => `<div class="card">
        <h2>${esc(t.name)}</h2><p class="muted">${esc(t.description || '')}</p>
        <dl class="kv"><dt>Zeilen</dt><dd>${t.config.rows.length}</dd><dt>Rotation</dt><dd>${t.config.rotation.enabled ? `${t.slots} Plätze, ${t.config.rotation.interval === 'weekly' ? 'wöchentlich ' + WEEKDAYS[t.config.rotation.weekday] : 'täglich'} ${t.config.rotation.time}` : 'aus'}</dd>
          ${t.config.rotation.enabled ? `<dt>Nächster Wechsel</dt><dd>${fmtDate(t.nextRoll)}</dd><dt>Zuletzt</dt><dd>${fmtDate(t.rotationState.rolledAt)}</dd>` : ''}</dl>
        <div class="actions" style="margin-top:12px"><a class="btn" href="#/vorlagen/${t.id}">Bearbeiten</a>${t.config.rotation.enabled ? `<button data-action="reroll" data-id="${t.id}">Jetzt neu würfeln</button>` : ''}</div>
      </div>`).join('') || '<div class="card muted">Noch keine Vorlagen.</div>'}
    </div>`
  onActions(view, {
    reroll: ({ id }) => rerollTemplate(id),
    fromUser: async () => {
      const v = await modal(`<h2>Startseite eines Benutzers übernehmen</h2>
        <label class="field"><span>Benutzer</span><select id="fu-user">${users.map((u) => opt(u.id, u.name)).join('')}</select></label>
        <label class="field"><span>Name der Vorlage</span><input id="fu-name" placeholder="z. B. Familie"></label>
        <div class="foot"><button data-close="">Abbrechen</button><button class="primary" data-close="ok">Übernehmen</button></div>`)
      if (v !== 'ok') return
      const t = await POST('/api/templates/from-user', { userId: modalFields['fu-user'], name: modalFields['fu-name'] })
      location.hash = `#/vorlagen/${t.id}`
    },
  })
}

async function rerollTemplate(id) {
  if (!(await confirmDialog('Jetzt neu würfeln?', 'Die Rotation wird sofort neu ausgelost und auf alle Benutzer angewendet, die diese Vorlage bereits haben (mit Backup).', { ok: 'Neu würfeln' }))) return
  const r = await POST(`/api/templates/${id}/reroll`)
  showResults('Neu gewürfelt', [`Rotation: ${r.shown.map((c) => c.name).join(', ') || 'keine Kandidaten'}`, ...(r.seasonal.length ? [`Saisonal aktiv: ${r.seasonal.join(', ')}`] : []), ...r.results.map((x) => `${x.user}: ${x.error || x.status}`)])
}

async function pageTemplateEdit(view, templateId) {
  const isNew = templateId === 'neu'
  const [t, { libraries }, cols, users] = await Promise.all([
    isNew ? GET('/api/templates-default').then((config) => ({ name: '', description: '', config })) : GET(`/api/templates/${templateId}`),
    GET('/api/libraries'), GET('/api/collections'), GET('/api/users'),
  ])
  const draft = clone(t)
  const libs = libraries.filter((l) => !l.aperture)
  const libChoices = [...APERTURE_TOKENS, ...libs.map((l) => [l.guid, l.name]), ...SPECIAL_VIEWS]
  const libName = (token) => libChoices.find(([v]) => v === token)?.[1] || token
  // ids of libraries that no longer exist (e.g. taken over from Emby's lists) are dropped; saving keeps it clean
  const known = new Set(libChoices.map(([v]) => v))
  for (const r of draft.config.rows) if (r.libraries) r.libraries.guids = r.libraries.guids.filter((g) => known.has(g))
  const filterSummary = (lib) => {
    if (lib.mode === 'all') return ''
    const shown = libChoices.filter(([v]) => libShown(lib, v)).map(([, l]) => l)
    const hidden = libChoices.filter(([v]) => !libShown(lib, v)).map(([, l]) => l)
    if (!shown.length) return ' · zeigt keine Bibliothek'
    return shown.length <= hidden.length ? ` · nur ${shown.join(', ')}` : ` · ohne ${hidden.join(', ')}`
  }
  const collections = cols.collections
  let openRow = null
  let tab = 'rows'

  const sortSelect = (row, i, list = SORTS) => `
    <label class="field"><span>Sortierung</span><select data-bind="config.rows.${i}.sortBy">${options(list, row.sortBy)}</select></label>
    <label class="field"><span>Reihenfolge</span><select data-bind="config.rows.${i}.sortOrder">${options(ORDERS, row.sortOrder)}</select></label>`
  const commonFields = (row, i, { view = [['', 'Karten'], ['spotlight', 'Spotlight']] } = {}) => `
    <label class="field"><span>Ansicht</span><select data-bind="config.rows.${i}.viewType">${options(view, row.viewType)}</select></label>
    <label class="field"><span>Bildtyp</span><select data-bind="config.rows.${i}.imageType">${options(IMAGE_TYPES, row.imageType)}</select></label>
    <label class="field"><span>Scrollrichtung</span><select data-bind="config.rows.${i}.scrollDirection">${options(SCROLL, row.scrollDirection)}</select></label>
    <label class="field"><span>Anzeigen auf</span><select data-bind="config.rows.${i}.displayMode">${options(DISPLAY_MODES, row.displayMode)}</select></label>`
  const libPicker = (r, i, hint = 'Häkchen = wird angezeigt (wie im Emby-Editor). Platzhalter und Live TV werden pro Benutzer aufgelöst.') => `
    <label class="field" style="margin:10px 0 4px"><span>In dieser Zeile angezeigte Bibliotheken</span></label>
    <div class="checklist" data-rowlib="${i}">${checkTools()}${libChoices.map(([v, l]) => `<label class="check"><input type="checkbox" data-rowlib-value="${esc(v)}"${checked(libShown(r.libraries, v))}> ${esc(l)}</label>`).join('')}</div>
    <label class="check"><input type="checkbox" data-rowlib-auto="${i}"${checked(r.libraries.mode !== 'only')}> Bibliotheken, die später dazukommen, automatisch anzeigen</label>
    <p class="hint">${hint}</p>`
  const boxsetLibHint = 'Die Zeile zeigt nur die Inhalte der Kollektion, die in den angehakten Bibliotheken liegen (wie das Feld „Bibliotheken“ im Emby-Editor).'
  const randomBoxsetHint = (row) => (row.sortBy === 'Random' ? '<div class="alert info small">Die Emby-Oberfläche bietet „Zufällig“ für Kollektionszeilen nicht an, der Server speichert SortBy aber frei. Ob die Zeile wirklich mischt, an einem Testbenutzer prüfen (Diagnose → Snapshot, dann Startseite zweimal laden).</div>' : '')

  function rowSummary(r) {
    if (r.kind === 'section') return `${meta.sectionTypes[r.sectionType] || r.sectionType}${r.customName ? ` „${r.customName}“` : ''}${filterSummary(r.libraries)}`
    if (r.kind === 'aperture') return `Eigene Aperture-${r.mediaType === 'series' ? 'Serien' : 'Filme'}${r.apertureStyle === 'latest' ? ' (Neu hinzugefügt)' : ''}`
    if (r.kind === 'collection') return `Kollektion: ${r.customName || r.collectionName || collections.find((c) => c.id === r.collectionId)?.name || '(keine gewählt)'}${filterSummary(r.libraries)}`
    if (r.kind === 'seasonal') return `Saisonal: ${r.collectionName || '(kein Name)'}${r.season?.from ? ` · ${r.season.from} bis ${r.season.to}` : ''}${filterSummary(r.libraries)}`
    return `Rotationsplatz${r.customName ? ` „${r.customName}“` : ''}${filterSummary(r.libraries)}`
  }

  function rowEditor(r, i) {
    const base = `<label class="field"><span>Eigener Titel</span><input data-bind="config.rows.${i}.customName" value="${esc(r.customName)}" placeholder="Standardtitel von Emby"></label>`
    if (r.kind === 'section') {
      return `<div class="row-fields">
        <label class="field"><span>Zeilentyp</span><select data-bind="config.rows.${i}.sectionType" data-rerender>${Object.entries(meta.sectionTypes).map(([v, l]) => opt(v, l, r.sectionType)).join('')}</select></label>
        ${base}
        ${r.sectionType === 'items' ? `<label class="field"><span>Medientyp</span><select data-bind="config.rows.${i}.itemTypes" data-type="list">${meta.itemTypes.map((x) => opt(x, ITEM_TYPE_LABELS[x] || x, r.itemTypes.join(','))).join('')}</select></label>` : ''}
        ${['items', 'collections', 'playlists'].includes(r.sectionType) ? sortSelect(r, i) : ''}
        ${commonFields(r, i, { view: r.sectionType === 'userviews' ? [['', 'Karten'], ['buttons', 'Schaltflächen']] : [['', 'Karten'], ['spotlight', 'Spotlight']] })}
      </div>
      ${r.sectionType === 'resume' ? `<label class="check"><input type="checkbox" data-bind="config.rows.${i}.includeNextUp"${checked(r.includeNextUp)}> „Als Nächstes“ in Weiterschauen einbeziehen</label>` : ''}
      ${libPicker(r, i)}`
    }
    if (r.kind === 'aperture') {
      return `<div class="row-fields">
        <label class="field"><span>Bibliothek</span><select data-bind="config.rows.${i}.mediaType">${options([['movies', 'Eigene Aperture-Filme'], ['series', 'Eigene Aperture-Serien']], r.mediaType)}</select></label>
        <label class="field"><span>Darstellung</span><select data-bind="config.rows.${i}.apertureStyle" data-rerender>${options([['items', 'Inhalte der Bibliothek'], ['latest', 'Neu hinzugefügt']], r.apertureStyle)}</select></label>
        ${base}${r.apertureStyle === 'items' ? sortSelect(r, i) : ''}${commonFields(r, i)}
      </div><p class="hint">Wird pro Benutzer durch seine eigene Aperture-Bibliothek ersetzt. Ohne Bibliothek entfällt die Zeile.</p>`
    }
    if (r.kind === 'collection') {
      return `<div class="row-fields">
        <label class="field"><span>Kollektion</span><select data-bind="config.rows.${i}.collectionId" data-rerender>${opt('', '– wählen –', r.collectionId)}${collections.filter((c) => c.id).map((c) => opt(c.id, `${c.name} (${c.childCount ?? '?'})`, r.collectionId)).join('')}</select></label>
        ${base}${sortSelect(r, i, COLLECTION_SORTS)}${commonFields(r, i)}
      </div>${libPicker(r, i, boxsetLibHint)}${randomBoxsetHint(r)}`
    }
    if (r.kind === 'seasonal') {
      return `<div class="row-fields">
        <label class="field"><span>Kollektionsname</span><input list="col-names" data-bind="config.rows.${i}.collectionName" value="${esc(r.collectionName)}"><small>Über den Namen gesucht – Ultimate Collections legt saisonale Kollektionen jedes Jahr neu an.</small></label>
        <label class="field"><span>Saison von (MM-TT)</span><input data-bind="config.rows.${i}.season.from" value="${esc(r.season?.from || '')}" placeholder="optional, z. B. 12-01"></label>
        <label class="field"><span>Saison bis (MM-TT)</span><input data-bind="config.rows.${i}.season.to" value="${esc(r.season?.to || '')}" placeholder="12-26"></label>
        ${base}${sortSelect(r, i, COLLECTION_SORTS)}${commonFields(r, i)}
      </div><p class="hint">Sichtbar nur, wenn die Kollektion existiert, Inhalte hat und der Benutzer den Großteil davon sehen darf. Ohne eigenes Zeitfenster gilt das von Ultimate Collections (falls bekannt).</p>${libPicker(r, i, boxsetLibHint)}${randomBoxsetHint(r)}`
    }
    return `<div class="row-fields">${base}${sortSelect(r, i, COLLECTION_SORTS)}${commonFields(r, i)}</div>
      <p class="hint">Wird mit einer Kollektion aus dem Rotations-Pool belegt; aktive saisonale Kollektionen haben Vorrang.</p>${libPicker(r, i, boxsetLibHint + ' Gilt für jede Kollektion, die auf diesem Platz landet.')}${randomBoxsetHint(r)}`
  }

  function renderRows() {
    return `<div class="rows-editor">
      ${draft.config.rows.map((r, i) => `<div class="trow ${openRow === r.id ? 'open' : ''}">
        <div class="num">${i + 1}</div>
        <div>${badge(KIND_LABELS[r.kind], KIND_BADGE[r.kind])} ${esc(rowSummary(r))} ${r.sortBy === 'Random' ? badge('zufällig') : ''}</div>
        <div class="actions"><button class="icon" data-action="up" data-i="${i}" title="Nach oben">↑</button><button class="icon" data-action="down" data-i="${i}" title="Nach unten">↓</button><button class="icon" data-action="toggle" data-id="${r.id}" title="Bearbeiten">✎</button><button class="icon danger" data-action="removeRow" data-i="${i}" title="Entfernen">✕</button></div>
        ${openRow === r.id ? `<div class="edit">${rowEditor(r, i)}</div>` : ''}
      </div>`).join('')}
      </div>
      <div class="actions" style="margin-top:10px">Zeile hinzufügen:
        <button data-action="addRow" data-kind="section">Emby-Zeile</button><button data-action="addRow" data-kind="aperture">Aperture-Platzhalter</button>
        <button data-action="addRow" data-kind="collection">Kollektion</button><button data-action="addRow" data-kind="seasonal">Saisonale Zeile</button><button data-action="addRow" data-kind="rotation">Rotationsplatz</button>
      </div>`
  }

  function renderLibraries() {
    const c = draft.config
    const order = [...c.libraryOrder.filter((g) => libChoices.some(([v]) => v === g)), ...libChoices.map(([v]) => v).filter((v) => !c.libraryOrder.includes(v))]
    c.libraryOrder = order
    return `<p class="muted">Reihenfolge der Bibliotheken in „Meine Medien“ und im Menü. Platzhalter werden pro Benutzer durch seine Aperture-Bibliotheken ersetzt.
      Welche Bibliotheken eine Zeile zeigt, stellst du direkt in der Zeile ein (Tab „Zeilen“, ✎).</p>
      <table><thead><tr><th>#</th><th>Bibliothek</th><th>Startansicht</th><th></th></tr></thead><tbody>
      ${order.map((v, i) => {
        const lib = libs.find((l) => l.guid === v)
        const landing = LANDING[lib?.collectionType] || (v === '@aperture:series' ? LANDING.tvshows : v === '@aperture:movies' ? LANDING.movies : v === '@type:livetv' ? LANDING.livetv : null)
        return `<tr><td>${i + 1}</td><td>${esc(libName(v))}</td>
          <td>${landing ? `<select data-bind="config.landing.${esc(v)}">${options(landing, c.landing[v] || '')}</select>` : '<span class="muted">–</span>'}</td>
          <td class="nowrap"><button class="icon" data-action="libUp" data-i="${i}">↑</button><button class="icon" data-action="libDown" data-i="${i}">↓</button></td></tr>`
      }).join('')}</tbody></table>
      <div class="row-fields" style="margin-top:14px">
        <label class="check"><input type="checkbox" data-bind="config.hidePlayedInLatest"${checked(c.hidePlayedInLatest)}> Gesehene Inhalte in „Neu hinzugefügt“ ausblenden</label>
        <label class="field"><span>TV-Startseite</span><select data-bind="config.tvHome">${options([['', 'nicht ändern'], ['vertical', 'vertikal'], ['horizontal', 'horizontal']], c.tvHome)}</select></label>
      </div>`
  }

  function renderRotation() {
    const r = draft.config.rotation
    const colOptions = (cur) => opt('', '– wählen –', cur) + collections.filter((c) => c.id).map((c) => opt(c.id, `${c.name} (${c.childCount ?? '?'})`, cur)).join('')
    const slots = draft.config.rows.filter((x) => x.kind === 'rotation').length
    return `<label class="check"><input type="checkbox" data-bind="config.rotation.enabled"${checked(r.enabled)} data-rerender> Rotation aktiv</label>
      <p class="muted">${slots} Rotationsplätze in den Zeilen. ${cols.ultimateCollections ? badge('Ultimate Collections erkannt', 'ok') : ''}</p>
      <div class="row-fields">
        <label class="field"><span>Intervall</span><select data-bind="config.rotation.interval" data-rerender>${options([['daily', 'täglich'], ['weekly', 'wöchentlich']], r.interval)}</select></label>
        ${r.interval === 'weekly' ? `<label class="field"><span>Wochentag</span><select data-bind="config.rotation.weekday" data-type="number">${WEEKDAYS.map((d, i) => opt(i, d, r.weekday)).join('')}</select></label>` : ''}
        <label class="field"><span>Uhrzeit</span><input type="time" data-bind="config.rotation.time" value="${esc(r.time)}"></label>
        <label class="field"><span>Keine Wiederholung der letzten N</span><input type="number" min="0" data-type="number" data-bind="config.rotation.avoidLastN" value="${r.avoidLastN}"></label>
        <label class="field"><span>Mindestens sichtbar (%)</span><input type="number" min="0" max="100" id="min-ratio" value="${Math.round(r.minVisibleRatio * 100)}"><small>Eine Kollektion wird einem Benutzer nur gezeigt, wenn er mindestens diesen Anteil der Inhalte sehen darf.</small></label>
      </div>
      <h3>Pool</h3>
      <table><thead><tr><th>Kollektion</th><th>Gewichtung (1–10)</th><th></th></tr></thead><tbody>
      ${r.pool.map((p, i) => `<tr><td><select data-bind="config.rotation.pool.${i}.collectionId" data-pool="${i}">${colOptions(p.collectionId)}</select></td><td><input type="number" min="1" max="10" data-type="number" data-bind="config.rotation.pool.${i}.weight" value="${p.weight}" style="width:90px"></td><td><button class="icon danger" data-action="poolRemove" data-i="${i}">✕</button></td></tr>`).join('') || '<tr><td colspan="3" class="muted">Leer</td></tr>'}
      </tbody></table>
      <div class="actions" style="margin-top:8px"><button data-action="poolAdd">Kollektion hinzufügen</button><button data-action="poolAddAll">Alle nicht-saisonalen hinzufügen</button></div>
      <h3>Saisonale Kollektionen (Vorrang vor der Rotation)</h3>
      <p class="hint">Ist eine davon aktiv (existiert, hat Inhalte, Benutzer darf sie sehen), belegt sie einen Rotationsplatz.</p>
      <table><thead><tr><th>Name</th><th>von (MM-TT)</th><th>bis</th><th>Ultimate Collections</th><th></th></tr></thead><tbody>
      ${r.seasonal.map((s, i) => {
        const c = collections.find((x) => x.name.toLowerCase() === s.collectionName.toLowerCase())
        return `<tr><td><input list="col-names" data-bind="config.rotation.seasonal.${i}.collectionName" value="${esc(s.collectionName)}"></td>
          <td><input data-bind="config.rotation.seasonal.${i}.season.from" value="${esc(s.season.from)}" placeholder="optional" style="width:90px"></td>
          <td><input data-bind="config.rotation.seasonal.${i}.season.to" value="${esc(s.season.to)}" style="width:90px"></td>
          <td class="small">${c?.uc ? `${esc(c.uc.seasonLabel || 'ganzjährig')} · ${esc(c.uc.label)}` : '<span class="muted">–</span>'}</td>
          <td><button class="icon danger" data-action="seasonRemove" data-i="${i}">✕</button></td></tr>`
      }).join('') || '<tr><td colspan="5" class="muted">Keine</td></tr>'}
      </tbody></table>
      <div class="actions" style="margin-top:8px"><button data-action="seasonAdd">Saisonale Kollektion hinzufügen</button>${collections.some((c) => c.uc?.season) ? '<button data-action="seasonAddUc">Alle saisonalen aus Ultimate Collections</button>' : ''}</div>
      ${isNew ? '' : `<h3>Verlauf</h3><div id="history" class="muted">Lade …</div>`}`
  }

  function render() {
    view.innerHTML = `
      <div class="page-head"><div><a href="#/vorlagen">← Vorlagen</a><h1>${isNew ? 'Neue Vorlage' : esc(t.name)}</h1></div>
        <div class="actions">${isNew ? '' : '<button class="danger" data-action="delete">Löschen</button><button data-action="reroll">Jetzt neu würfeln</button>'}<button class="primary" data-action="save">Speichern</button></div></div>
      <datalist id="col-names">${collections.map((c) => `<option value="${esc(c.name)}">`).join('')}</datalist>
      <div class="grid" style="grid-template-columns: minmax(0, 3fr) minmax(280px, 2fr); align-items:start">
        <div class="card">
          <div class="row-fields"><label class="field"><span>Name</span><input data-bind="name" value="${esc(draft.name)}"></label><label class="field"><span>Beschreibung</span><input data-bind="description" value="${esc(draft.description)}"></label></div>
          <div class="tabs">${[['rows', 'Zeilen'], ['libs', 'Bibliotheken'], ['rotation', 'Rotation & Saison']].map(([k, l]) => `<button data-action="tab" data-tab="${k}" class="${tab === k ? 'active' : ''}">${l}</button>`).join('')}</div>
          <div id="tab-body">${tab === 'rows' ? renderRows() : tab === 'libs' ? renderLibraries() : renderRotation()}</div>
        </div>
        <div class="card" style="position:sticky;top:16px">
          <h2>Vorschau</h2>
          <div class="row-fields">
            <label class="field"><span>Zeitpunkt</span><select id="pv-when">${options([['today', 'Heute'], ['tomorrow', 'Morgen'], ['nextweek', 'Nächste Woche']], 'today')}</select></label>
            <label class="field"><span>Benutzer</span><select id="pv-user">${opt('', 'allgemein (ohne Benutzer)')}${users.map((u) => opt(u.id, u.name)).join('')}</select></label>
          </div>
          <button data-action="preview">Vorschau aktualisieren</button>
          <div id="preview" style="margin-top:12px"></div>
        </div>
      </div>`
    if (tab === 'rotation' && !isNew) loadHistory()
  }

  async function loadHistory() {
    const h = await GET(`/api/templates/${templateId}/history`)
    const el = $('#history')
    if (el) el.innerHTML = h.length ? `<table><tbody>${h.slice(0, 30).map((x) => `<tr><td class="nowrap">${fmtDate(x.shown_at)}</td><td>${esc(x.collection_name)}</td></tr>`).join('')}</tbody></table>` : 'Noch nichts gezeigt.'
  }

  async function preview() {
    if (isNew) return ($('#preview').innerHTML = '<p class="muted">Erst speichern.</p>')
    const r = await POST(`/api/templates/${templateId}/preview`, { config: draft.config, when: $('#pv-when').value, userId: $('#pv-user').value || null })
    $('#preview').innerHTML = `<p class="small muted">Stand: ${fmtDate(r.date)}${r.user ? ` · für ${esc(r.user.name)}` : ''}</p>
      <ul class="preview-list">${r.rows.map((x) => `<li class="${x.shown ? '' : 'hidden'}"><span>${esc(x.label)} ${x.source === 'seasonal' ? badge('Saison', 'warn') : x.kind === 'rotation' ? badge('Rotation', 'kids') : ''}${x.predicted ? badge('voraussichtlich') : ''}${x.placeholder ? badge('Platzhalter', 'info') : ''}${x.libraries ? `<div class="small muted">zeigt ${x.libraries.length === x.librariesTotal ? 'alle Bibliotheken' : x.libraries.length ? esc(x.libraries.join(', ')) : 'keine Bibliothek'}</div>` : ''}</span><span class="small muted">${esc(x.note || '')}</span></li>`).join('')}</ul>`
  }

  render()
  // Row library filter: the boxes mean "shown". Stored as 'all', as 'except' (hidden ones; later libraries
  // appear by themselves) or, with "automatisch anzeigen" off, as 'only' (shown ones).
  view.addEventListener('change', (e) => {
    const box = e.target.closest('[data-rowlib-value],[data-rowlib-auto]')
    if (!box) return
    const i = box.dataset.rowlibAuto ?? box.closest('[data-rowlib]').dataset.rowlib
    const boxes = $$('[data-rowlib-value]', view.querySelector(`[data-rowlib="${i}"]`))
    const shown = boxes.filter((c) => c.checked).map((c) => c.dataset.rowlibValue)
    const hidden = boxes.filter((c) => !c.checked).map((c) => c.dataset.rowlibValue)
    const auto = view.querySelector(`[data-rowlib-auto="${i}"]`).checked
    draft.config.rows[i].libraries = auto ? (hidden.length ? { mode: 'except', guids: hidden } : { mode: 'all', guids: [] }) : { mode: 'only', guids: shown }
  })
  bindInputs(view, draft, (el) => {
    if (el.dataset.pool !== undefined) {
      const c = collections.find((x) => x.id === el.value)
      draft.config.rotation.pool[el.dataset.pool].collectionName = c?.name || ''
    }
    if (el.matches('[data-bind^="config.rows."][data-bind$=".collectionId"]')) {
      const i = el.dataset.bind.split('.')[2]
      draft.config.rows[i].collectionName = collections.find((x) => x.id === el.value)?.name || ''
    }
    if (el.dataset.rerender !== undefined) render()
  })
  view.addEventListener('input', (e) => {
    if (e.target.id === 'min-ratio') draft.config.rotation.minVisibleRatio = Math.min(100, Math.max(0, Number(e.target.value) || 0)) / 100
  })
  const move = (arr, i, d) => {
    const j = i + d
    if (j < 0 || j >= arr.length) return
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  onActions(view, {
    tab: ({ tab: k }) => {
      tab = k
      render()
    },
    up: ({ i }) => (move(draft.config.rows, Number(i), -1), render()),
    down: ({ i }) => (move(draft.config.rows, Number(i), 1), render()),
    toggle: ({ id }) => ((openRow = openRow === id ? null : id), render()),
    removeRow: ({ i }) => (draft.config.rows.splice(Number(i), 1), render()),
    addRow: ({ kind }) => {
      const id = 'r' + Math.random().toString(16).slice(2, 10)
      const row = { id, kind, customName: '', sortBy: '', sortOrder: '', viewType: '', imageType: '', scrollDirection: '', displayMode: '', cardSizeOffset: 0 }
      if (kind !== 'aperture') row.libraries = { mode: 'all', guids: [] }
      if (kind === 'section') Object.assign(row, { sectionType: 'latestmediablock', itemTypes: [], includeNextUp: true, query: {} })
      if (kind === 'aperture') Object.assign(row, { mediaType: 'movies', apertureStyle: 'items' })
      if (kind === 'collection') Object.assign(row, { collectionId: '', collectionName: '' })
      if (kind === 'seasonal') Object.assign(row, { collectionName: '', season: { from: '', to: '' } })
      draft.config.rows.push(row)
      openRow = id
      render()
    },
    libUp: ({ i }) => (move(draft.config.libraryOrder, Number(i), -1), render()),
    libDown: ({ i }) => (move(draft.config.libraryOrder, Number(i), 1), render()),
    poolAdd: () => (draft.config.rotation.pool.push({ collectionId: '', collectionName: '', weight: 1 }), render()),
    poolAddAll: () => {
      const have = new Set(draft.config.rotation.pool.map((p) => p.collectionId))
      const seasonal = new Set(draft.config.rotation.seasonal.map((s) => s.collectionName.toLowerCase()))
      for (const c of collections) if (c.id && !c.uc?.season && !have.has(c.id) && !seasonal.has(c.name.toLowerCase())) draft.config.rotation.pool.push({ collectionId: c.id, collectionName: c.name, weight: 1 })
      render()
    },
    poolRemove: ({ i }) => (draft.config.rotation.pool.splice(Number(i), 1), render()),
    seasonAdd: () => (draft.config.rotation.seasonal.push({ collectionName: '', season: { from: '', to: '' } }), render()),
    seasonAddUc: () => {
      const have = new Set(draft.config.rotation.seasonal.map((s) => s.collectionName.toLowerCase()))
      for (const c of collections) if (c.uc?.season && !have.has(c.name.toLowerCase())) draft.config.rotation.seasonal.push({ collectionName: c.name, season: { from: '', to: '' } })
      render()
    },
    seasonRemove: ({ i }) => (draft.config.rotation.seasonal.splice(Number(i), 1), render()),
    preview,
    reroll: () => rerollTemplate(templateId),
    save: async () => {
      draft.config.rotation.pool = draft.config.rotation.pool.filter((p) => p.collectionId)
      const s = isNew ? await POST('/api/templates', draft) : await PUT(`/api/templates/${templateId}`, draft)
      toast('Vorlage gespeichert')
      if (isNew) location.hash = `#/vorlagen/${s.id}`
      else Object.assign(draft, clone(s)), render()
    },
    delete: async () => {
      if (!(await confirmDialog('Vorlage löschen?', `„${esc(t.name)}“ wird gelöscht. Layout-Gruppen mit dieser Vorlage verlieren ihre Zuordnung.`, { ok: 'Löschen', danger: true }))) return
      await DEL(`/api/templates/${templateId}`)
      location.hash = '#/vorlagen'
    },
  })
}

// ---------------------------------------------------------------- layout groups

async function pageLayoutGroups(view, groupId) {
  if (groupId) return pageLayoutGroupEdit(view, groupId)
  const [list, tpls] = await Promise.all([GET('/api/layout-groups'), GET('/api/templates')])
  view.innerHTML = `
    <div class="page-head"><div><h1>Layout-Gruppen</h1><div class="sub">Jede Layout-Gruppe hat genau eine Homescreen-Vorlage; jeder Benutzer ist in höchstens einer Layout-Gruppe.</div></div>
      <div class="actions"><a class="btn" href="#/layouts/neu" style="background:var(--accent);color:#fff;border-color:var(--accent)">Neue Layout-Gruppe</a></div></div>
    <div class="grid cols-3">${list.map((g) => `<div class="card"><h2>${esc(g.name)}</h2>
      <dl class="kv"><dt>Vorlage</dt><dd>${esc(tpls.find((t) => t.id === g.templateId)?.name || '–')}</dd><dt>Mitglieder</dt><dd>${g.userIds.length}</dd><dt>Automatisch</dt><dd>${g.autoApply ? 'ja (Rotation, Saison, Aperture)' : 'nein'}</dd></dl>
      <div class="actions" style="margin-top:12px"><a class="btn" href="#/layouts/${g.id}">Öffnen</a></div></div>`).join('') || '<div class="card muted">Noch keine Layout-Gruppen.</div>'}</div>`
}

async function pageLayoutGroupEdit(view, groupId) {
  const isNew = groupId === 'neu'
  const [list, tpls, users] = await Promise.all([GET('/api/layout-groups'), GET('/api/templates'), GET('/api/users')])
  const g = isNew ? { name: '', templateId: null, autoApply: true, userIds: [] } : list.find((x) => String(x.id) === groupId)
  if (!g) throw new Error('Layout-Gruppe nicht gefunden')
  const draft = clone(g)
  const otherGroup = (uid) => list.find((x) => x.id !== g.id && x.userIds.includes(uid))
  view.innerHTML = `
    <div class="page-head"><div><a href="#/layouts">← Layout-Gruppen</a><h1>${isNew ? 'Neue Layout-Gruppe' : esc(g.name)}</h1></div>
      <div class="actions">${isNew ? '' : '<button class="danger" data-action="delete">Löschen</button><button data-action="preview">Vorschau</button><button data-action="apply">Auf alle Mitglieder anwenden</button><button class="danger" data-action="overwrite">Alle überschreiben</button>'}<button class="primary" data-action="save">Speichern</button></div></div>
    <div class="grid cols-2">
      <div class="card">
        <label class="field"><span>Name</span><input data-bind="name" value="${esc(draft.name)}"></label>
        <label class="field"><span>Vorlage</span><select data-bind="templateId" data-type="number">${opt('', '– keine –', draft.templateId ?? '')}${tpls.map((t) => opt(t.id, t.name, draft.templateId)).join('')}</select></label>
        <label class="check"><input type="checkbox" data-bind="autoApply"${checked(draft.autoApply)}> Beim Abgleich automatisch aktualisieren (Rotation, Saison, neue Aperture-Bibliotheken)</label>
        <p class="hint">Automatisch aktualisiert werden nur Benutzer, auf die die Vorlage schon einmal angewendet wurde. Vor jeder Änderung wird ein Backup angelegt.</p>
        <div id="lg-result"></div>
      </div>
      <div class="card"><h2>Mitglieder</h2>
        <div class="checklist">${checkTools()}${users.map((u) => `<label class="check"><input type="checkbox" data-bind="userIds" data-list-value="${esc(u.id)}"${checked(draft.userIds.includes(u.id))}> ${esc(u.name)} ${otherGroup(u.id) ? `<span class="small muted">(jetzt in „${esc(otherGroup(u.id).name)}“)</span>` : ''}</label>`).join('')}</div>
        <p class="hint">Ein Benutzer kann nur in einer Layout-Gruppe sein – Anhaken verschiebt ihn hierher.</p>
      </div>
    </div>`
  bindInputs(view, draft)
  const run = async (force) => {
    const pv = await GET(`/api/layout-groups/${groupId}/preview`)
    const changed = pv.users.filter((u) => u.changed || force)
    const ok = await confirmDialog(force ? 'Alle überschreiben?' : 'Auf alle Mitglieder anwenden?', `
      ${status?.dryRun ? '<div class="alert warn">Dry-Run aktiv – es wird nur protokolliert.</div>' : ''}
      <p>Vorlage „${esc(pv.template.name)}“ wird auf <b>${changed.length}</b> Benutzer geschrieben${force ? ' (auch unveränderte)' : ''}. Vorher wird pro Benutzer ein Backup der bisherigen Startseite angelegt (unter „Backups“ wiederherstellbar).</p>
      <ul>${changed.map((u) => `<li>${esc(u.user)}${u.legacy ? ' <span class="muted small">(bisher Emby-Standard)</span>' : ''}</li>`).join('')}</ul>`, { ok: force ? 'Alle überschreiben' : 'Anwenden', danger: force })
    if (!ok) return
    const r = await POST(`/api/layout-groups/${groupId}/apply`, { force })
    showResults('Ergebnis', r.results.map((x) => `${x.user}: ${x.error ? 'Fehler – ' + x.error : { applied: 'angewendet', unchanged: 'unverändert', 'dry-run': 'Dry-Run' }[x.status] || x.status}`))
  }
  onActions(view, {
    save: async () => {
      const s = isNew ? await POST('/api/layout-groups', draft) : await PUT(`/api/layout-groups/${groupId}`, draft)
      toast('Gespeichert')
      location.hash = `#/layouts/${s.id}`
      if (!isNew) route()
    },
    preview: async () => {
      const pv = await GET(`/api/layout-groups/${groupId}/preview`)
      $('#lg-result').innerHTML = `<h3>Vorschau</h3><table><thead><tr><th>Benutzer</th><th>Bisher</th><th>Neu</th></tr></thead><tbody>${pv.users.map((u) => u.error ? `<tr><td>${esc(u.user)}</td><td colspan="2" class="diff-del">${esc(u.error)}</td></tr>` : `<tr><td>${esc(u.user)} ${u.changed ? badge('ändert sich', 'warn') : badge('aktuell', 'ok')}</td><td class="small">${u.legacy ? '<i>Emby-Standard</i><br>' : ''}${u.current.map(esc).join('<br>')}</td><td class="small">${u.next.map(esc).join('<br>')}</td></tr>`).join('')}</tbody></table>`
    },
    apply: () => run(false),
    overwrite: () => run(true),
    delete: async () => {
      if (!(await confirmDialog('Layout-Gruppe löschen?', 'Die Startseiten der Benutzer bleiben, wie sie sind.', { ok: 'Löschen', danger: true }))) return
      await DEL(`/api/layout-groups/${groupId}`)
      location.hash = '#/layouts'
    },
  })
}

// ---------------------------------------------------------------- backups

function backupTable(list) {
  if (!list.length) return '<p class="muted">Keine Backups.</p>'
  return `<div class="table-wrap"><table><thead><tr><th>Datum</th><th>Benutzer</th><th>Art</th><th>Zeilen</th><th></th></tr></thead><tbody>
    ${list.map((b) => `<tr><td class="nowrap">${fmtDate(b.createdAt)} ${b.isOriginal ? badge('Original', 'ok') : ''}</td><td>${esc(b.userName)}</td><td>${esc(b.kind)}<div class="small muted">${esc(b.reason)}</div></td>
      <td class="small">${b.legacy ? '<i>Emby-Standard (nicht gespeichert)</i><br>' : ''}${b.rows.map(esc).join(' · ')}</td>
      <td class="nowrap"><button class="small" data-action="viewBackup" data-id="${b.id}">Ansehen</button> <button class="small" data-action="restoreBackup" data-id="${b.id}" data-name="${esc(b.userName)}">Wiederherstellen</button></td></tr>`).join('')}
  </tbody></table></div>`
}

function backupActions() {
  return {
    viewBackup: async ({ id }) => showJson(`Backup #${id}`, (await GET(`/api/backups/${id}`)).data),
    restoreBackup: async ({ id, name }) => {
      if (!(await confirmDialog('Backup wiederherstellen?', `Die Startseite von <b>${esc(name)}</b> wird auf den Stand von Backup #${id} zurückgesetzt. Der aktuelle Stand wird vorher selbst gesichert.`, { ok: 'Wiederherstellen' }))) return
      const r = await POST(`/api/backups/${id}/restore`)
      toast(r.dryRun ? 'Dry-Run: nur protokolliert' : 'Wiederhergestellt')
      route()
    },
  }
}

async function pageBackups(view) {
  const [list, users] = await Promise.all([GET('/api/backups'), GET('/api/users')])
  let userId = ''
  const render = () => ($('#backup-list').innerHTML = backupTable(list.filter((b) => !userId || b.userId === userId)))
  view.innerHTML = `
    <div class="page-head"><div><h1>Backups</h1><div class="sub">Vor jeder Änderung an einer Startseite wird gesichert. Das erste Backup pro Benutzer („Original“) wird nie automatisch gelöscht.</div></div>
      <div class="actions"><select id="bk-user" style="width:220px">${opt('', 'Alle Benutzer')}${users.map((u) => opt(u.id, u.name)).join('')}</select></div></div>
    <div class="card" id="backup-list"></div>`
  render()
  $('#bk-user').onchange = (e) => {
    userId = e.target.value
    render()
  }
  onActions(view, backupActions())
}

// ---------------------------------------------------------------- diagnostics

async function pageDiagnostics(view) {
  const [users, snaps] = await Promise.all([GET('/api/users'), GET('/api/diagnostics/snapshots')])
  view.innerHTML = `
    <div class="page-head"><div><h1>Diagnose</h1><div class="sub">Rohdaten, die Emby für einen Benutzer speichert – zum Nachprüfen, wie Emby Startseite, Sortierung und Einstellungen ablegt.</div></div></div>
    <div class="card"><h2>So prüfst du das Speicherformat an einem Testbenutzer</h2>
      <ol>
        <li>Testbenutzer wählen und einen Snapshot „vorher“ anlegen.</li>
        <li>In Emby (als dieser Benutzer oder als Admin unter Benutzer → Startseite) eine Sache ändern, z. B. eine Zeile auf „Zufällig“ sortieren.</li>
        <li>Snapshot „nachher“ anlegen und beide vergleichen. Die Tabelle zeigt genau, welche Felder Emby geändert hat.</li>
      </ol>
      <div class="row-fields">
        <label class="field"><span>Benutzer</span><select id="dg-user">${users.map((u) => opt(u.id, u.name)).join('')}</select></label>
        <label class="field"><span>Bezeichnung</span><input id="dg-label" value="vorher"></label>
      </div>
      <button class="primary" data-action="snap">Snapshot anlegen</button>
    </div>
    <div class="card"><h2>Snapshots</h2>
      ${snaps.length ? `<table><thead><tr><th>A</th><th>B</th><th>Datum</th><th>Benutzer</th><th>Bezeichnung</th><th></th></tr></thead><tbody>
        ${snaps.map((s, i) => `<tr><td><input type="radio" name="a" value="${s.id}"${i === 1 ? ' checked' : ''}></td><td><input type="radio" name="b" value="${s.id}"${i === 0 ? ' checked' : ''}></td><td>${fmtDate(s.created_at)}</td><td>${esc(s.user_name)}</td><td>${esc(s.label)}</td>
          <td class="nowrap"><button class="small" data-action="view" data-id="${s.id}">Ansehen</button> <button class="small danger" data-action="del" data-id="${s.id}">✕</button></td></tr>`).join('')}
      </tbody></table><div class="actions" style="margin-top:10px"><button data-action="compare">A mit B vergleichen</button></div>` : '<p class="muted">Noch keine Snapshots.</p>'}
      <div id="dg-diff"></div>
    </div>`
  onActions(view, {
    snap: async () => {
      await POST('/api/diagnostics/snapshot', { userId: $('#dg-user').value, label: $('#dg-label').value })
      toast('Snapshot gespeichert')
      route()
    },
    view: async ({ id }) => showJson(`Snapshot #${id}`, (await GET(`/api/diagnostics/snapshots/${id}`)).data),
    del: async ({ id }) => {
      await DEL(`/api/diagnostics/snapshots/${id}`)
      route()
    },
    compare: async () => {
      const a = $('input[name=a]:checked')?.value
      const b = $('input[name=b]:checked')?.value
      if (!a || !b) return toast('A und B wählen', 'error')
      const r = await GET(`/api/diagnostics/compare?a=${a}&b=${b}`)
      $('#dg-diff').innerHTML = `<h3>${esc(r.a.label)} → ${esc(r.b.label)}: ${r.changes.length} Unterschiede</h3>
        <table><thead><tr><th>Feld</th><th>Vorher</th><th>Nachher</th></tr></thead><tbody>${r.changes.map((c) => `<tr><td><code>${esc(c.path)}</code></td><td class="diff-del"><code>${esc(JSON.stringify(c.before))}</code></td><td class="diff-add"><code>${esc(JSON.stringify(c.after))}</code></td></tr>`).join('')}</tbody></table>`
    },
  })
}

// ---------------------------------------------------------------- log

async function pageLog(view) {
  let offset = 0
  let action = ''
  const load = async () => {
    const r = await GET(`/api/log?limit=100&offset=${offset}&action=${encodeURIComponent(action)}`)
    $('#log-body').innerHTML = r.rows.map((x) => `<tr><td class="nowrap">${fmtDate(x.ts)}</td><td>${esc(x.actor)}</td><td><code>${esc(x.action)}</code></td><td>${esc(x.target)}</td>
      <td>${x.dry_run ? badge('Dry-Run', 'warn') : ''}${x.ok ? '' : badge('Fehler', 'danger')} ${esc(x.summary)} ${x.details ? `<button class="small" data-action="details" data-id="${x.id}">Details</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Keine Einträge.</td></tr>'
    $('#log-info').textContent = `${Math.min(r.total, offset + 1)}–${Math.min(r.total, offset + 100)} von ${r.total}`
    view._rows = r.rows
  }
  view.innerHTML = `
    <div class="page-head"><div><h1>Protokoll</h1><div class="sub">Alle Änderungen, auch im Dry-Run</div></div>
      <div class="actions"><select id="log-filter">${options([['', 'Alle'], ['policy', 'Rechte'], ['homescreen', 'Homescreens'], ['rotation', 'Rotation'], ['sync', 'Abgleich'], ['group', 'Gruppen'], ['layout', 'Layout-Gruppen'], ['template', 'Vorlagen'], ['backup', 'Backups'], ['settings', 'Einstellungen']], '')}</select></div></div>
    <div class="card table-wrap"><table><thead><tr><th>Zeit</th><th>Von</th><th>Aktion</th><th>Ziel</th><th>Beschreibung</th></tr></thead><tbody id="log-body"></tbody></table>
      <div class="actions" style="margin-top:10px"><button data-action="prev">← Neuer</button><span id="log-info" class="muted"></span><button data-action="next">Älter →</button></div></div>`
  await load()
  $('#log-filter').onchange = (e) => {
    action = e.target.value
    offset = 0
    load()
  }
  onActions(view, {
    prev: () => ((offset = Math.max(0, offset - 100)), load()),
    next: () => ((offset += 100), load()),
    details: ({ id }) => showJson('Details', view._rows.find((x) => String(x.id) === id)?.details),
  })
}

// ---------------------------------------------------------------- settings

async function pageSettings(view) {
  const [s, lgs, ygs] = await Promise.all([GET('/api/settings'), GET('/api/library-groups'), GET('/api/layout-groups')])
  const draft = { dryRun: s.dryRun, syncIntervalMinutes: s.syncIntervalMinutes, autoGrantAperture: s.autoGrantAperture, defaultLibraryGroupId: s.defaultLibraryGroupId, defaultLayoutGroupId: s.defaultLayoutGroupId, backupsPerUser: s.backupsPerUser, defaultUnratedTypes: s.defaultUnratedTypes }
  view.innerHTML = `
    <div class="page-head"><div><h1>Einstellungen</h1></div><div class="actions"><button class="primary" data-action="save">Speichern</button></div></div>
    <div class="grid cols-2">
      <div class="card"><h2>Betrieb</h2>
        <label class="check"><input type="checkbox" data-bind="dryRun"${checked(draft.dryRun)}> <b>Dry-Run</b>: nichts an Emby senden, nur protokollieren</label>
        <label class="field" style="margin-top:12px"><span>Abgleich alle … Minuten</span><input type="number" min="5" data-type="number" data-bind="syncIntervalMinutes" value="${draft.syncIntervalMinutes}"><small>Fällige Rotationen werden zusätzlich jede Minute geprüft.</small></label>
        <label class="check"><input type="checkbox" data-bind="autoGrantAperture"${checked(draft.autoGrantAperture)}> Neue Aperture-Bibliotheken beim Abgleich automatisch dem Besitzer freigeben (nur verwaltete Benutzer)</label>
        <label class="field" style="margin-top:12px"><span>Backups pro Benutzer</span><input type="number" min="1" data-type="number" data-bind="backupsPerUser" value="${draft.backupsPerUser}"><small>Zusätzlich zum Original-Backup.</small></label>
      </div>
      <div class="card"><h2>Neue Benutzer</h2>
        <label class="field"><span>Standard-Bibliotheksgruppe</span><select data-bind="defaultLibraryGroupId" data-type="number">${opt('', '– keine –', draft.defaultLibraryGroupId ?? '')}${lgs.map((g) => opt(g.id, g.name, draft.defaultLibraryGroupId)).join('')}</select></label>
        <label class="field"><span>Standard-Layout-Gruppe</span><select data-bind="defaultLayoutGroupId" data-type="number">${opt('', '– keine –', draft.defaultLayoutGroupId ?? '')}${ygs.map((g) => opt(g.id, g.name, draft.defaultLayoutGroupId)).join('')}</select>
          <small>Neue Benutzer bekommen beim nächsten Abgleich diese Gruppen; Rechte und Startseite werden direkt angewendet.</small></label>
        <h3>Vorauswahl „nicht bewertete Inhalte blockieren“</h3>
        <div class="checklist">${checkTools()}${meta.unratedTypes.map((t) => `<label class="check"><input type="checkbox" data-bind="defaultUnratedTypes" data-list-value="${t}"${checked(draft.defaultUnratedTypes.includes(t))}> ${esc(UNRATED_LABELS[t] || t)}</label>`).join('')}</div>
      </div>
      <div class="card"><h2>Verbindungen (aus Umgebungsvariablen)</h2>
        <dl class="kv"><dt>EMBY_URL</dt><dd>${esc(s.env.embyUrl || '–')}</dd><dt>APERTURE_URL</dt><dd>${esc(s.env.apertureUrl || '–')}</dd><dt>APERTURE_DB_URL</dt><dd>${s.env.apertureDb ? 'gesetzt' : '–'}</dd><dt>ADMIN_PASSWORD</dt><dd>${s.env.adminPassword ? 'gesetzt' : '–'}</dd></dl>
        <p class="hint">Das Aperture-Namensschema wird unter „Bibliotheken & Aperture“ eingestellt.</p>
      </div>
    </div>`
  bindInputs(view, draft)
  onActions(view, {
    save: async () => {
      const r = await PUT('/api/settings', draft)
      meta.settings = r
      status = { ...status, dryRun: r.dryRun }
      toast('Einstellungen gespeichert')
      route()
    },
  })
}
