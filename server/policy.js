// Effective rights per user and writing them to the Emby user policy.
//
// Effective libraries = libraries of all the user's library groups + the user's own Aperture libraries; never
// another user's Aperture library. Strictest rating wins (lowest MaxParentalRating), unrated types and blocked tags
// are merged. Users in no library group are not managed: nothing is written for them.
//
// Writing: Emby has no partial policy endpoint, so the current policy is read right before the write and only the
// MANAGED_FIELDS are replaced; every other field goes back exactly as Emby returned it.

import { emby } from './emby.js'
import { listLibraryGroups, libraryGroupsOfUser } from './groups.js'
import { ownApertureGuids } from './state.js'
import { logChange } from './changelog.js'

export const MANAGED_FIELDS = ['EnableAllFolders', 'EnabledFolders', 'MaxParentalRating', 'BlockUnratedItems', 'BlockedTags']

const FIELD_LABELS = {
  EnableAllFolders: 'Zugriff auf alle Bibliotheken',
  EnabledFolders: 'Bibliotheken',
  MaxParentalRating: 'Max. Altersfreigabe',
  BlockUnratedItems: 'Nicht bewertete Inhalte blockieren',
  BlockedTags: 'Gesperrte Tags',
}

const norm = (s) => String(s || '').toLowerCase().replace(/-/g, '')

export function effectiveRights(state, user, groups = listLibraryGroups()) {
  const mine = libraryGroupsOfUser(user.Id, groups)
  const apertureGuids = new Set(state.libraries.filter((l) => l.aperture).map((l) => l.guid))
  const existing = new Set(state.libraries.map((l) => l.guid))
  const own = ownApertureGuids(state, user.Id)

  const folders = new Set()
  for (const g of mine) for (const guid of g.libraryGuids) if (!apertureGuids.has(guid) && existing.has(guid)) folders.add(guid)
  if (mine.length) for (const guid of own) folders.add(guid)

  const ratings = mine.map((g) => g.maxParentalRating).filter((r) => r != null)
  const unrated = new Set(mine.flatMap((g) => g.blockUnrated))
  const tags = new Map()
  for (const t of mine.flatMap((g) => g.blockedTags)) tags.set(t.toLowerCase(), tags.get(t.toLowerCase()) || t)

  return {
    managed: mine.length > 0,
    groups: mine.map((g) => ({ id: g.id, name: g.name, isKids: g.isKids })),
    isKids: mine.some((g) => g.isKids),
    ownApertureGuids: own,
    policy: {
      EnableAllFolders: false,
      EnabledFolders: [...folders].sort(),
      MaxParentalRating: ratings.length ? Math.min(...ratings) : null,
      BlockUnratedItems: [...unrated].sort(),
      BlockedTags: [...tags.values()].sort((a, b) => a.localeCompare(b)),
    },
  }
}

const sameSet = (a = [], b = [], key = (x) => x) => {
  const x = new Set(a.map(key))
  const y = new Set(b.map(key))
  return x.size === y.size && [...x].every((v) => y.has(v))
}

function fieldEqual(field, current, wanted) {
  switch (field) {
    case 'EnabledFolders':
      return sameSet(current || [], wanted, norm)
    case 'BlockUnratedItems':
      return sameSet(current || [], wanted)
    case 'BlockedTags':
      return sameSet(current || [], wanted, (t) => t.toLowerCase())
    case 'MaxParentalRating':
      return (current ?? null) === (wanted ?? null)
    default:
      return Boolean(current) === Boolean(wanted)
  }
}

function describe(state, field, value) {
  if (field === 'EnabledFolders') {
    const names = new Map(state.libraries.map((l) => [norm(l.guid), l.name]))
    return (value || []).map((g) => names.get(norm(g)) || `unbekannt (${g})`)
  }
  if (field === 'MaxParentalRating') {
    if (value == null) return 'keine Beschränkung'
    const r = state.ratings.filter((x) => x.Value <= value).pop()
    return r ? `${r.Name} (${value})` : String(value)
  }
  if (field === 'EnableAllFolders') return value ? 'ja' : 'nein'
  return value || []
}

export function policyDiff(state, user, rights) {
  const current = user.Policy || {}
  const changes = []
  if (!rights.managed) return changes
  for (const field of MANAGED_FIELDS) {
    if (fieldEqual(field, current[field], rights.policy[field])) continue
    const change = { field, label: FIELD_LABELS[field], from: describe(state, field, current[field]), to: describe(state, field, rights.policy[field]) }
    if (field === 'EnabledFolders') {
      const cur = new Set((current.EnabledFolders || []).map(norm))
      const want = new Set(rights.policy.EnabledFolders.map(norm))
      const names = new Map(state.libraries.map((l) => [norm(l.guid), l.name]))
      change.added = [...want].filter((g) => !cur.has(g)).map((g) => names.get(g) || g)
      change.removed = [...cur].filter((g) => !want.has(g)).map((g) => names.get(g) || `unbekannt (${g})`)
    }
    changes.push(change)
  }
  return changes
}

// Warnings for the overview, independent of whether the user is managed.
export function userWarnings(state, user, rights) {
  const warnings = []
  const p = user.Policy || {}
  const foreign = state.libraries.filter((l) => l.aperture && l.aperture.ownerId !== user.Id)
  const enabled = new Set((p.EnabledFolders || []).map(norm))
  const sees = p.EnableAllFolders ? foreign : foreign.filter((l) => enabled.has(norm(l.guid)))
  if (sees.length) warnings.push(`Sieht fremde Aperture-Bibliotheken: ${sees.map((l) => l.name).join(', ')}${rights.managed ? ' (wird beim Anwenden entfernt)' : ''}`)
  if (!rights.managed && p.EnableAllFolders) warnings.push('Nicht verwaltet: hat Zugriff auf alle Bibliotheken')
  // Emby applies MyMediaExcludes to "Meine Medien" and the library menu, and the 4.10 settings page no longer shows it
  const names = new Map(state.libraries.map((l) => [norm(l.guid), l.name]))
  const hiddenInMyMedia = (user.Configuration?.MyMediaExcludes || []).map((g) => names.get(norm(g))).filter(Boolean)
  if (hiddenInMyMedia.length) warnings.push(`In „Meine Medien“ und im Menü versteckt (Emby-Einstellung MyMediaExcludes): ${hiddenInMyMedia.join(', ')} – wird beim Anwenden einer Vorlage geleert`)
  return warnings
}

export function previewUsers(state, userIds = null) {
  const groups = listLibraryGroups()
  return state.users
    .filter((u) => !userIds || userIds.includes(u.Id))
    .map((u) => {
      const rights = effectiveRights(state, u, groups)
      return { userId: u.Id, userName: u.Name, isAdmin: !!u.Policy?.IsAdministrator, managed: rights.managed, groups: rights.groups, changes: policyDiff(state, u, rights) }
    })
}

/** Writes the managed fields for one user. Returns { changed, changes }. */
export async function applyUserPolicy(state, userId, { actor, dryRun, reason = '' }) {
  // Read fresh: the cached state can be seconds old, and the write sends the whole policy back.
  const user = await emby.user(userId)
  const rights = effectiveRights(state, user)
  if (!rights.managed) return { changed: false, changes: [], skipped: 'nicht verwaltet' }
  const changes = policyDiff(state, user, rights)
  if (!changes.length) return { changed: false, changes }
  const policy = { ...user.Policy }
  for (const field of MANAGED_FIELDS) policy[field] = rights.policy[field]
  const summary = changes.map((c) => c.label).join(', ') + (reason ? ` – ${reason}` : '')
  if (dryRun) {
    logChange({ actor, action: 'policy.apply', target: user.Name, summary, details: { changes }, dryRun: true })
    return { changed: true, changes, dryRun: true }
  }
  try {
    await emby.updatePolicy(user.Id, policy)
    logChange({ actor, action: 'policy.apply', target: user.Name, summary, details: { changes, before: pick(user.Policy), after: pick(policy) } })
  } catch (e) {
    logChange({ actor, action: 'policy.apply', target: user.Name, summary: e.message, details: { changes }, ok: false })
    throw e
  }
  return { changed: true, changes }
}

/** Adds one library to a user's EnabledFolders without touching anything else (sync: new Aperture library). */
export async function grantLibrary(userId, guid, { actor, dryRun, libraryName }) {
  const user = await emby.user(userId)
  const p = user.Policy || {}
  if (p.EnableAllFolders || (p.EnabledFolders || []).some((g) => norm(g) === norm(guid))) return false
  const policy = { ...p, EnabledFolders: [...(p.EnabledFolders || []), guid] }
  if (!dryRun) await emby.updatePolicy(user.Id, policy)
  logChange({ actor, action: 'policy.grant', target: user.Name, summary: `Neue Aperture-Bibliothek freigegeben: ${libraryName}`, dryRun })
  return true
}

const pick = (p = {}) => Object.fromEntries(MANAGED_FIELDS.map((f) => [f, p[f]]))
