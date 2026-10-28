// Runtime settings, editable in the UI. Stored as JSON values in the settings table; DEFAULTS fills the gaps, with
// env vars (config.js) as the initial value where one exists.

import { config } from './config.js'
import { all, run, parseJson } from './db.js'

const DEFAULTS = {
  dryRun: config.dryRun,
  syncIntervalMinutes: config.syncIntervalMinutes,
  // Aperture name pattern (fallback method 4). {username} and {type} are placeholders.
  apertureNamePattern: 'Für dich ausgewählt {username} {type}',
  apertureTypeMovies: 'Filme',
  apertureTypeSeries: 'Serien',
  // Grant newly created Aperture libraries to their owner during the periodic sync.
  autoGrantAperture: true,
  // New Emby users are put into these groups by the periodic sync (null = none).
  defaultLibraryGroupId: null,
  defaultLayoutGroupId: null,
  // Unrated item types a group blocks when "nicht bewertete Inhalte blockieren" is on, unless the group lists its own.
  defaultUnratedTypes: ['Movie', 'Series', 'Trailer', 'Book', 'Game', 'ChannelContent', 'Other'],
  // Backups kept per user besides the original one taken before the first change.
  backupsPerUser: 15,
  lastSync: null,
}

export function getSettings() {
  const stored = Object.fromEntries(all('SELECT key, value FROM settings').map((r) => [r.key, parseJson(r.value, null)]))
  return { ...DEFAULTS, ...stored }
}

export function getSetting(key) {
  return getSettings()[key]
}

export function setSettings(patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULTS)) continue
    run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value))
  }
  return getSettings()
}
