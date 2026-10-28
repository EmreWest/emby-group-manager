// Emby REST client. Every endpoint used here was checked against Emby Server 4.10.2 (web client source and the
// route attributes in Emby.Api.dll); see docs/EMBY-API.md for what was verified and how.

import { config } from './config.js'

const CLIENT_HEADER = 'Emby Client="Emby Group Manager", Device="Server", DeviceId="emby-group-manager", Version="1.0.0"'

export class EmbyError extends Error {
  constructor(message, status, body) {
    super(message)
    this.status = status
    this.body = body
  }
}

export function embyConfigured() {
  return Boolean(config.embyUrl && config.embyApiKey)
}

async function request(method, path, { body, token = config.embyApiKey, query } = {}) {
  if (!config.embyUrl) throw new EmbyError('EMBY_URL ist nicht gesetzt', 0)
  const url = new URL(config.embyUrl + path)
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
  }
  const headers = { Accept: 'application/json', 'X-Emby-Authorization': CLIENT_HEADER }
  if (token) headers['X-Emby-Token'] = token
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  let res
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) })
  } catch (e) {
    throw new EmbyError(`Emby nicht erreichbar (${url.origin}): ${e.cause?.code || e.message}`, 0)
  }
  const text = await res.text()
  if (!res.ok) throw new EmbyError(`Emby ${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`, res.status, text)
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

const items = (r) => (Array.isArray(r) ? r : r?.Items || [])

export const emby = {
  systemInfo: () => request('GET', '/System/Info'),

  // ---- users ----
  async users() {
    return items(await request('GET', '/Users/Query', { query: { IsHidden: '', IsDisabled: '' } }).catch(() => request('GET', '/Users')))
  },
  user: (id) => request('GET', `/Users/${id}`),
  // There is no partial endpoint for the policy (only POST /Users/{Id}/Policy), so callers read the user first and
  // send the complete policy back with only their fields changed.
  updatePolicy: (id, policy) => request('POST', `/Users/${id}/Policy`, { body: policy }),
  updateConfigurationPartial: (id, partial) => request('POST', `/Users/${id}/Configuration/Partial`, { body: partial }),

  async authenticate(username, password) {
    return request('POST', '/Users/AuthenticateByName', { token: null, body: { Username: username, Pw: password } })
  },
  logout: (token) => request('POST', '/Sessions/Logout', { token }).catch(() => null),

  // ---- libraries ----
  // VirtualFolderInfo: Name, Locations, CollectionType, ItemId, Id, Guid. Policy.EnabledFolders holds the Guid
  // (the access tab uses folder.Guid || folder.Id).
  async virtualFolders() {
    return items(await request('GET', '/Library/VirtualFolders'))
  },
  async userViews(userId) {
    return items(await request('GET', `/Users/${userId}/Views`, { query: { IncludeHidden: true } }))
  },
  async parentalRatings() {
    return items(await request('GET', '/Localization/ParentalRatings'))
  },

  // ---- collections ----
  async collections(userId) {
    const path = userId ? `/Users/${userId}/Items` : '/Items'
    return items(await request('GET', path, {
      query: { IncludeItemTypes: 'BoxSet', Recursive: true, Fields: 'ChildCount,Path,DateCreated', SortBy: 'SortName' },
    }))
  },
  // Number of items in a container as a user sees them (library access + parental rating applied by Emby).
  async childCount(parentId, userId) {
    const path = userId ? `/Users/${userId}/Items` : '/Items'
    const r = await request('GET', path, { query: { ParentId: parentId, Limit: 0, Recursive: false } })
    return r?.TotalRecordCount ?? 0
  },

  // ---- home screen (server side since 4.10.0.4) ----
  // GET in edit mode returns the stored sections, or Emby's legacy defaults for a user who never saved any.
  async homeSections(userId) {
    const r = await request('GET', `/Users/${userId}/HomeSections`, { query: { IsEditMode: true } })
    return Array.isArray(r) ? r : r?.Sections || r?.Items || []
  },
  // Emby assigns the Id itself; the new section is appended.
  addHomeSection: (userId, section) => request('POST', `/Users/${userId}/HomeSections`, { body: section }),
  deleteHomeSections: (userId, ids) => request('POST', `/Users/${userId}/HomeSections/Delete`, { body: { Ids: ids } }),
  moveHomeSections: (userId, ids, newIndex) => request('POST', `/Users/${userId}/HomeSections/Move`, { body: { Ids: ids, NewIndex: newIndex } }),

  // What a row actually shows for this user (same call the Emby apps make). Section ids of the stored rows work
  // here, except latestmediablock, which Emby expands into one "latestmedia_<library>" row per library.
  async sectionItemCount(userId, sectionId) {
    const r = await request('GET', `/Users/${userId}/Sections/${encodeURIComponent(sectionId)}/Items`, { query: { Limit: 1, EnableTotalRecordCount: true } })
    return r?.TotalRecordCount ?? r?.Items?.length ?? 0
  },

  // ---- user settings (former DisplayPreferences "usersettings", per user since 4.9.0.23) ----
  userSettings: (userId) => request('GET', `/UserSettings/${userId}`),
  updateUserSettingsPartial: (userId, partial) => request('POST', `/UserSettings/${userId}/Partial`, { body: partial }),

  // ---- plugins (optional) ----
  ultimateCollectionsStatus: () => request('GET', '/UltimateCollections/Status'),
}
