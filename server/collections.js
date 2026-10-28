// Collections (BoxSets) as rows and rotation candidates, with the checks the rotation needs: does it exist, does
// it have items, and how much of it can a given user see. "Can see" is asked of Emby itself (items counted as that
// user), so library access, MaxParentalRating, unrated blocking and blocked tags all count, exactly as Emby applies
// them.

import { emby } from './emby.js'
import { parseUcSeason } from './seasons.js'

export async function loadCollections(state) {
  const admin = state.users.find((u) => u.Policy?.IsAdministrator && u.Policy?.EnableAllFolders && !u.Policy?.IsDisabled)
  const raw = await emby.collections(admin?.Id)
  let uc = null
  try {
    uc = await emby.ultimateCollectionsStatus()
  } catch {
    uc = null // plugin not installed
  }
  const ucByName = new Map((uc?.Collections || []).map((c) => [String(c.Name).toLowerCase(), c]))
  const ucInfo = (c) => (c ? { season: parseUcSeason(c.Season), seasonLabel: c.Season || null, label: c.Label, active: !!c.Active, nextStart: c.NextStart || null } : null)

  const list = raw.map((c) => ({ id: c.Id, name: c.Name, childCount: c.ChildCount ?? null, uc: ucInfo(ucByName.get(String(c.Name).toLowerCase())) }))
  // Ultimate Collections deletes seasonal collections off season; list them anyway so they can be picked.
  const have = new Set(list.map((c) => c.name.toLowerCase()))
  for (const c of uc?.Collections || []) {
    if (!have.has(String(c.Name).toLowerCase())) list.push({ id: null, name: c.Name, childCount: 0, uc: ucInfo(c) })
  }
  return { list, adminId: admin?.Id || null, ultimateCollections: !!uc }
}

export function createCollectionContext(collections) {
  const byId = new Map(collections.list.filter((c) => c.id).map((c) => [c.id, c]))
  const byName = new Map()
  for (const c of collections.list) {
    const key = c.name.toLowerCase()
    // prefer an existing collection over an off-season placeholder with the same name
    if (!byName.has(key) || (!byName.get(key).id && c.id)) byName.set(key, c)
  }
  const totals = new Map()
  const perUser = new Map()

  const ctx = {
    collections,
    // By id first; a collection deleted and rebuilt by a plugin gets a new id, so fall back to the name.
    find({ id, name } = {}) {
      return (id && byId.get(id)) || (name && byName.get(String(name).toLowerCase())) || null
    },
    async total(c) {
      if (!c?.id) return 0
      if (c.childCount != null) return c.childCount
      if (!totals.has(c.id)) totals.set(c.id, emby.childCount(c.id, collections.adminId).catch(() => 0))
      return totals.get(c.id)
    },
    async visibleRatio(c, userId) {
      const total = await ctx.total(c)
      if (!total) return 0
      const key = `${c.id}|${userId}`
      if (!perUser.has(key)) perUser.set(key, emby.childCount(c.id, userId).catch(() => 0))
      return Math.min(1, (await perUser.get(key)) / total)
    },
    // Exists, has items, and (when a user is given) the user may see at least minRatio of it.
    async usable(c, userId, minRatio) {
      if (!c?.id || !(await ctx.total(c))) return false
      if (!userId) return true
      return (await ctx.visibleRatio(c, userId)) >= minRatio
    },
  }
  return ctx
}
