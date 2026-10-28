// Library groups (rights) and layout groups (home screen template). Plain CRUD on SQLite.

import { all, get, run, tx, now, parseJson } from './db.js'
import { HttpError } from './http.js'

// ---- library groups ----

function libraryGroupRow(g) {
  return {
    id: g.id,
    name: g.name,
    description: g.description,
    isKids: !!g.is_kids,
    maxParentalRating: g.max_parental_rating,
    blockUnrated: parseJson(g.block_unrated, []),
    blockedTags: parseJson(g.blocked_tags, []),
    userIds: all('SELECT user_id FROM library_group_users WHERE group_id = ?', g.id).map((r) => r.user_id),
    libraryGuids: all('SELECT library_guid FROM library_group_libraries WHERE group_id = ?', g.id).map((r) => r.library_guid),
    updatedAt: g.updated_at,
  }
}

export function listLibraryGroups() {
  return all('SELECT * FROM library_groups ORDER BY name COLLATE NOCASE').map(libraryGroupRow)
}

export function getLibraryGroup(id) {
  const g = get('SELECT * FROM library_groups WHERE id = ?', id)
  if (!g) throw new HttpError(404, 'Gruppe nicht gefunden')
  return libraryGroupRow(g)
}

const cleanList = (v) => [...new Set((Array.isArray(v) ? v : []).map((x) => String(x).trim()).filter(Boolean))]

export function saveLibraryGroup(id, body) {
  const name = String(body.name || '').trim()
  if (!name) throw new HttpError(400, 'Name fehlt')
  const rating = body.maxParentalRating === '' || body.maxParentalRating == null ? null : Number(body.maxParentalRating)
  if (rating != null && !Number.isFinite(rating)) throw new HttpError(400, 'Ungültige Altersfreigabe')
  const fields = [name, String(body.description || ''), body.isKids ? 1 : 0, rating, JSON.stringify(cleanList(body.blockUnrated)), JSON.stringify(cleanList(body.blockedTags)), now()]
  return tx(() => {
    if (id) {
      if (!get('SELECT id FROM library_groups WHERE id = ?', id)) throw new HttpError(404, 'Gruppe nicht gefunden')
      run('UPDATE library_groups SET name=?, description=?, is_kids=?, max_parental_rating=?, block_unrated=?, blocked_tags=?, updated_at=? WHERE id=?', ...fields, id)
    } else {
      id = Number(run('INSERT INTO library_groups (name, description, is_kids, max_parental_rating, block_unrated, blocked_tags, updated_at, created_at) VALUES (?,?,?,?,?,?,?,?)', ...fields, now()).lastInsertRowid)
    }
    if (Array.isArray(body.userIds)) {
      run('DELETE FROM library_group_users WHERE group_id = ?', id)
      for (const u of cleanList(body.userIds)) run('INSERT INTO library_group_users (group_id, user_id) VALUES (?, ?)', id, u)
    }
    if (Array.isArray(body.libraryGuids)) {
      run('DELETE FROM library_group_libraries WHERE group_id = ?', id)
      for (const l of cleanList(body.libraryGuids)) run('INSERT INTO library_group_libraries (group_id, library_guid) VALUES (?, ?)', id, l)
    }
    return getLibraryGroup(id)
  })
}

export function deleteLibraryGroup(id) {
  run('DELETE FROM library_groups WHERE id = ?', id)
}

export function addUserToLibraryGroup(groupId, userId) {
  run('INSERT OR IGNORE INTO library_group_users (group_id, user_id) VALUES (?, ?)', groupId, userId)
}

export function libraryGroupsOfUser(userId, groups = listLibraryGroups()) {
  return groups.filter((g) => g.userIds.includes(userId))
}

// ---- layout groups ----

function layoutGroupRow(g) {
  return {
    id: g.id,
    name: g.name,
    templateId: g.template_id,
    autoApply: !!g.auto_apply,
    userIds: all('SELECT user_id FROM layout_group_users WHERE group_id = ?', g.id).map((r) => r.user_id),
    updatedAt: g.updated_at,
  }
}

export function listLayoutGroups() {
  return all('SELECT * FROM layout_groups ORDER BY name COLLATE NOCASE').map(layoutGroupRow)
}

export function getLayoutGroup(id) {
  const g = get('SELECT * FROM layout_groups WHERE id = ?', id)
  if (!g) throw new HttpError(404, 'Layout-Gruppe nicht gefunden')
  return layoutGroupRow(g)
}

export function saveLayoutGroup(id, body) {
  const name = String(body.name || '').trim()
  if (!name) throw new HttpError(400, 'Name fehlt')
  const templateId = body.templateId ? Number(body.templateId) : null
  if (templateId && !get('SELECT id FROM templates WHERE id = ?', templateId)) throw new HttpError(400, 'Vorlage nicht gefunden')
  return tx(() => {
    if (id) {
      if (!get('SELECT id FROM layout_groups WHERE id = ?', id)) throw new HttpError(404, 'Layout-Gruppe nicht gefunden')
      run('UPDATE layout_groups SET name=?, template_id=?, auto_apply=?, updated_at=? WHERE id=?', name, templateId, body.autoApply === false ? 0 : 1, now(), id)
    } else {
      id = Number(run('INSERT INTO layout_groups (name, template_id, auto_apply, created_at, updated_at) VALUES (?,?,?,?,?)', name, templateId, body.autoApply === false ? 0 : 1, now(), now()).lastInsertRowid)
    }
    if (Array.isArray(body.userIds)) {
      run('DELETE FROM layout_group_users WHERE group_id = ?', id)
      // A user can only be in one layout group: joining this one takes them out of any other.
      for (const u of cleanList(body.userIds)) {
        run('DELETE FROM layout_group_users WHERE user_id = ?', u)
        run('INSERT INTO layout_group_users (group_id, user_id) VALUES (?, ?)', id, u)
      }
    }
    return getLayoutGroup(id)
  })
}

export function deleteLayoutGroup(id) {
  run('DELETE FROM layout_groups WHERE id = ?', id)
}

export function addUserToLayoutGroup(groupId, userId) {
  run('DELETE FROM layout_group_users WHERE user_id = ?', userId)
  run('INSERT INTO layout_group_users (group_id, user_id) VALUES (?, ?)', groupId, userId)
}

export function layoutGroupOfUser(userId, groups = listLayoutGroups()) {
  return groups.find((g) => g.userIds.includes(userId)) || null
}
