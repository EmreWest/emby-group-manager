// SQLite storage (node:sqlite, no native module). One file in DATA_DIR; schema changes go into MIGRATIONS as new
// entries, never by editing an old one, because existing installs have already run it.

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { config } from './config.js'

const MIGRATIONS = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, username TEXT NOT NULL, emby_user_id TEXT,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
  );

  CREATE TABLE library_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    is_kids INTEGER NOT NULL DEFAULT 0,
    max_parental_rating INTEGER,
    block_unrated TEXT NOT NULL DEFAULT '[]',
    blocked_tags TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE library_group_users (
    group_id INTEGER NOT NULL REFERENCES library_groups(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    PRIMARY KEY (group_id, user_id)
  );
  CREATE TABLE library_group_libraries (
    group_id INTEGER NOT NULL REFERENCES library_groups(id) ON DELETE CASCADE,
    library_guid TEXT NOT NULL,
    PRIMARY KEY (group_id, library_guid)
  );

  CREATE TABLE templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    config TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE layout_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL,
    auto_apply INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  -- a user is in at most one layout group, so there is never a question which template wins
  CREATE TABLE layout_group_users (
    group_id INTEGER NOT NULL REFERENCES layout_groups(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL UNIQUE,
    PRIMARY KEY (group_id, user_id)
  );
  -- what this tool last wrote to a user's home screen; the periodic sync only re-applies to users listed here
  CREATE TABLE user_layout_state (
    user_id TEXT PRIMARY KEY,
    template_id INTEGER,
    applied_hash TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );

  CREATE TABLE rotation_state (
    template_id INTEGER PRIMARY KEY REFERENCES templates(id) ON DELETE CASCADE,
    ranked TEXT NOT NULL DEFAULT '[]',
    rolled_at TEXT,
    roll_key TEXT,
    nonce INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE rotation_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    template_id INTEGER NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
    collection_id TEXT, collection_name TEXT NOT NULL,
    shown_at TEXT NOT NULL
  );

  CREATE TABLE backups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL, user_name TEXT NOT NULL,
    kind TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    is_original INTEGER NOT NULL DEFAULT 0,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_backups_user ON backups(user_id, created_at);

  CREATE TABLE snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL, user_name TEXT NOT NULL,
    label TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL
  );

  CREATE TABLE change_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '',
    details TEXT, dry_run INTEGER NOT NULL DEFAULT 0, ok INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX idx_change_log_ts ON change_log(ts);

  CREATE TABLE known_users (user_id TEXT PRIMARY KEY, name TEXT NOT NULL, first_seen TEXT NOT NULL);
  CREATE TABLE known_aperture_libs (library_guid TEXT PRIMARY KEY, user_id TEXT, first_seen TEXT NOT NULL);
  `,
]

fs.mkdirSync(config.dataDir, { recursive: true })
export const db = new DatabaseSync(path.join(config.dataDir, 'app.db'))
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')

function migrate() {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)')
  const row = db.prepare('SELECT version FROM schema_version').get()
  let version = row ? row.version : 0
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run()
  while (version < MIGRATIONS.length) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[version])
      version++
      db.prepare('UPDATE schema_version SET version = ?').run(version)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }
}
migrate()

export const now = () => new Date().toISOString()

export function all(sql, ...params) {
  return db.prepare(sql).all(...params)
}
export function get(sql, ...params) {
  return db.prepare(sql).get(...params)
}
export function run(sql, ...params) {
  return db.prepare(sql).run(...params)
}

export function tx(fn) {
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

export function parseJson(text, fallback) {
  if (text == null) return fallback
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}
