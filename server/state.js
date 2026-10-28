// One read of everything the pages and the sync need from Emby (+ Aperture), cached for a few seconds so a page
// that calls several endpoints does not hit Emby several times.

import { emby, embyConfigured } from './emby.js'
import { resolveApertureLibraries } from './aperture.js'
import { getSettings } from './settings.js'

const TTL_MS = 15000
let cache = null
let pending = null

export function invalidateState() {
  cache = null
}

export async function loadState({ force = false } = {}) {
  if (!embyConfigured()) throw Object.assign(new Error('EMBY_URL und EMBY_API_KEY sind nicht gesetzt'), { status: 503 })
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.state
  if (pending) return pending
  pending = (async () => {
    const [users, folders, ratings] = await Promise.all([emby.users(), emby.virtualFolders(), emby.parentalRatings().catch(() => [])])
    const settings = getSettings()
    const aperture = await resolveApertureLibraries(folders, users, settings)
    const apertureByGuid = new Map(aperture.libraries.map((l) => [l.guid, l]))
    const libraries = folders.map((f) => {
      const guid = f.Guid || f.ItemId || f.Id
      return {
        guid,
        itemId: f.ItemId || f.Id,
        name: f.Name,
        collectionType: f.CollectionType || '',
        locations: f.Locations || [],
        aperture: apertureByGuid.get(guid) || null,
      }
    })
    const state = { users, libraries, aperture, ratings: dedupeRatings(ratings), settings, at: Date.now() }
    cache = { at: Date.now(), state }
    return state
  })()
  try {
    return await pending
  } finally {
    pending = null
  }
}

// Several rating names share one value (e.g. FSK-12 / PG-13); the policy stores only the value.
function dedupeRatings(ratings) {
  const byValue = new Map()
  for (const r of ratings) {
    if (r.Value == null) continue
    const cur = byValue.get(r.Value)
    byValue.set(r.Value, cur ? { ...cur, Name: `${cur.Name} / ${r.Name}` } : { Name: r.Name, Value: r.Value })
  }
  return [...byValue.values()].sort((a, b) => a.Value - b.Value)
}

export const isApertureGuid = (state, guid) => state.libraries.some((l) => l.guid === guid && l.aperture)
export const ownApertureGuids = (state, userId) => state.libraries.filter((l) => l.aperture?.ownerId === userId).map((l) => l.guid)
