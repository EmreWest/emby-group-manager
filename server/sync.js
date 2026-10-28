// The periodic sync. Steps:
//   1. new Emby users: remember them, put them into the default groups (if set), apply their rights
//   2. Aperture libraries: grant each owner (managed users only) their own library if it is missing;
//      libraries without an owner are reported, never granted
//   3. rotation: roll every template whose roll time has passed
//   4. home screens: re-apply templates to users this tool has already written to (and to new users of the
//      default layout group) when the resolved layout changed (rotation, season, new Aperture library, …)
// The first run only records the existing users, so they are not treated as new.

import { all, run, now } from './db.js'
import { getSettings, setSettings } from './settings.js'
import { loadState, invalidateState } from './state.js'
import { logChange } from './changelog.js'
import { listLibraryGroups, listLayoutGroups, addUserToLibraryGroup, addUserToLayoutGroup } from './groups.js'
import { applyUserPolicy, grantLibrary } from './policy.js'
import { listTemplates } from './templates.js'
import { isRollDue, rollTemplate } from './rotation.js'
import { loadCollections, createCollectionContext } from './collections.js'
import { applyTemplateToUser, layoutState } from './homescreen.js'

let running = null

export const syncRunning = () => Boolean(running)

export function runSync(opts = {}) {
  if (!running) running = doSync(opts).finally(() => (running = null))
  return running
}

async function doSync({ actor = 'Abgleich', reason = 'Intervall' } = {}) {
  const settings = getSettings()
  const dryRun = settings.dryRun
  const report = { startedAt: now(), reason, dryRun, newUsers: [], granted: [], unassignedAperture: [], rolled: [], homescreens: [], errors: [] }
  const fail = (where, e) => {
    report.errors.push(`${where}: ${e.message}`)
    console.error(`[sync] ${where}:`, e)
  }

  try {
    invalidateState()
    const state = await loadState({ force: true })
    const libraryGroups = listLibraryGroups()
    const layoutGroups = listLayoutGroups()

    // 1. new users
    const known = new Set(all('SELECT user_id FROM known_users').map((r) => r.user_id))
    const firstRun = known.size === 0
    const newLayoutUsers = new Set()
    for (const u of state.users) {
      if (known.has(u.Id)) continue
      run('INSERT OR IGNORE INTO known_users (user_id, name, first_seen) VALUES (?, ?, ?)', u.Id, u.Name, now())
      if (firstRun) continue
      report.newUsers.push(u.Name)
      logChange({ actor, action: 'sync.new-user', target: u.Name, summary: 'Neuer Emby-Benutzer erkannt' })
      const lg = libraryGroups.find((g) => g.id === settings.defaultLibraryGroupId)
      if (lg) {
        addUserToLibraryGroup(lg.id, u.Id)
        lg.userIds.push(u.Id)
        logChange({ actor, action: 'group.member', target: u.Name, summary: `Zur Standard-Bibliotheksgruppe „${lg.name}“ hinzugefügt` })
        try {
          await applyUserPolicy(state, u.Id, { actor, dryRun, reason: 'neuer Benutzer' })
        } catch (e) {
          fail(`Rechte für ${u.Name}`, e)
        }
      }
      const yg = layoutGroups.find((g) => g.id === settings.defaultLayoutGroupId)
      if (yg) {
        addUserToLayoutGroup(yg.id, u.Id)
        yg.userIds.push(u.Id)
        newLayoutUsers.add(u.Id)
        logChange({ actor, action: 'group.member', target: u.Name, summary: `Zur Standard-Layout-Gruppe „${yg.name}“ hinzugefügt` })
      }
    }

    // 2. Aperture libraries
    const knownLibs = new Set(all('SELECT library_guid FROM known_aperture_libs').map((r) => r.library_guid))
    const managed = new Set(libraryGroups.flatMap((g) => g.userIds))
    for (const lib of state.libraries.filter((l) => l.aperture)) {
      const a = lib.aperture
      if (!knownLibs.has(lib.guid)) {
        run('INSERT OR IGNORE INTO known_aperture_libs (library_guid, user_id, first_seen) VALUES (?, ?, ?)', lib.guid, a.ownerId, now())
        logChange({ actor, action: 'sync.aperture', target: lib.name, summary: a.ownerId ? `Aperture-Bibliothek von ${a.ownerName} erkannt (${a.method})` : `Aperture-Bibliothek ohne Zuordnung: ${a.problem || 'unbekannt'}`, ok: !!a.ownerId })
      }
      if (!a.ownerId) {
        report.unassignedAperture.push(lib.name)
        continue
      }
      if (!settings.autoGrantAperture || !managed.has(a.ownerId)) continue
      try {
        if (await grantLibrary(a.ownerId, lib.guid, { actor, dryRun, libraryName: lib.name })) report.granted.push(`${lib.name} → ${a.ownerName}`)
      } catch (e) {
        fail(`Freigabe ${lib.name}`, e)
      }
    }

    // 3 + 4. rotation and home screens
    const templates = listTemplates()
    const groupsToApply = layoutGroups.filter((g) => g.autoApply && g.templateId)
    let cctx = null
    const ctx = async () => (cctx ||= createCollectionContext(await loadCollections(state)))
    for (const t of templates) {
      if (!isRollDue(t)) continue
      try {
        const r = await rollTemplate(t, await ctx())
        report.rolled.push(`${t.name}: ${r.shown.map((c) => c.name).join(', ') || '–'}`)
        logChange({ actor, action: 'rotation.roll', target: t.name, summary: `Neu gewürfelt: ${r.shown.map((c) => c.name).join(', ') || 'keine Kandidaten'}`, details: { seasonal: r.seasonal.map((s) => s.name) }, dryRun })
      } catch (e) {
        fail(`Rotation ${t.name}`, e)
      }
    }
    for (const g of groupsToApply) {
      const t = templates.find((x) => x.id === g.templateId)
      if (!t) continue
      for (const userId of g.userIds) {
        const st = layoutState(userId)
        if (!(st?.template_id === t.id || newLayoutUsers.has(userId))) continue
        if (!state.users.some((u) => u.Id === userId)) continue
        try {
          const r = await applyTemplateToUser(t, userId, { state, cctx: await ctx(), actor, dryRun, reason: 'Abgleich', backupKind: 'automatisch' })
          if (r.status !== 'unchanged') report.homescreens.push(`${state.users.find((u) => u.Id === userId)?.Name}: ${r.status}`)
        } catch (e) {
          fail(`Homescreen ${state.users.find((u) => u.Id === userId)?.Name || userId}`, e)
        }
      }
    }
  } catch (e) {
    fail('Abgleich', e)
  }

  report.finishedAt = now()
  setSettings({ lastSync: report })
  return report
}

export function startScheduler() {
  const tick = async () => {
    if (running) return
    const s = getSettings()
    const last = s.lastSync?.finishedAt ? Date.parse(s.lastSync.finishedAt) : 0
    const due = Date.now() - last >= s.syncIntervalMinutes * 60000
    let rollDue = false
    if (!due) {
      try {
        rollDue = listTemplates().some((t) => isRollDue(t))
      } catch {
        rollDue = false
      }
    }
    if (due || rollDue) runSync({ reason: due ? 'Intervall' : 'Rotation fällig' }).catch((e) => console.error('[sync]', e))
  }
  setTimeout(tick, 5000)
  return setInterval(tick, 60000)
}
