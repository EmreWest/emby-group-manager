// Log of every change this tool makes (or would make, in dry-run). Also printed to stdout for `docker logs`.

import { all, get, run, now } from './db.js'

export function logChange({ actor, action, target = '', summary = '', details = null, dryRun = false, ok = true }) {
  run(
    'INSERT INTO change_log (ts, actor, action, target, summary, details, dry_run, ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    now(), actor || 'System', action, target, summary, details == null ? null : JSON.stringify(details), dryRun ? 1 : 0, ok ? 1 : 0,
  )
  const flag = dryRun ? ' [DRY-RUN]' : ''
  const state = ok ? '' : ' [FEHLER]'
  console.log(`[${new Date().toISOString()}] ${actor || 'System'} ${action}${flag}${state} ${target} – ${summary}`)
}

export function listChanges({ limit = 200, offset = 0, action = '' } = {}) {
  const rows = action
    ? all('SELECT * FROM change_log WHERE action LIKE ? ORDER BY id DESC LIMIT ? OFFSET ?', `${action}%`, limit, offset)
    : all('SELECT * FROM change_log ORDER BY id DESC LIMIT ? OFFSET ?', limit, offset)
  const total = action
    ? get('SELECT COUNT(*) AS n FROM change_log WHERE action LIKE ?', `${action}%`).n
    : get('SELECT COUNT(*) AS n FROM change_log').n
  return { total, rows: rows.map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null, dry_run: !!r.dry_run, ok: !!r.ok })) }
}
