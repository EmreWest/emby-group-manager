// Configuration from environment variables. Everything that can change at runtime (dry-run, intervals, name
// pattern, default groups) lives in the settings table instead; the values here are only the defaults for it.

import path from 'node:path'

function str(name, fallback = '') {
  const v = process.env[name]
  return v == null || v === '' ? fallback : v.trim()
}

function num(name, fallback) {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v : fallback
}

function bool(name, fallback) {
  const v = str(name).toLowerCase()
  if (!v) return fallback
  return ['1', 'true', 'yes', 'ja', 'on'].includes(v)
}

export const config = {
  port: num('PORT', 8080),
  dataDir: path.resolve(str('DATA_DIR', './data')),

  embyUrl: str('EMBY_URL').replace(/\/+$/, ''),
  embyApiKey: str('EMBY_API_KEY'),

  apertureUrl: str('APERTURE_URL').replace(/\/+$/, ''),
  apertureApiKey: str('APERTURE_API_KEY'),
  apertureDbUrl: str('APERTURE_DB_URL'),

  syncIntervalMinutes: num('SYNC_INTERVAL_MINUTES', 60),
  dryRun: bool('DRY_RUN', false),

  adminUser: str('ADMIN_USER', 'admin'),
  adminPassword: str('ADMIN_PASSWORD'),
  sessionDays: num('SESSION_DAYS', 7),
  secureCookies: bool('SECURE_COOKIES', false),
}
