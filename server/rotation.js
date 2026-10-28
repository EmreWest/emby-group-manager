// Rotation: which pool collections fill a template's rotation slots.
//
// A roll ranks the whole pool (weighted random order, collections shown in the last N rolls moved to the end) and
// stores the ranking. Each user then takes the first collections from it that exist, have items and that they can
// see enough of (minVisibleRatio). Active seasonal collections take slots before the rotation does.
// Rolls are seeded with template id + roll date + reroll counter, so the preview of a future roll is the roll that
// will actually happen (unless the pool or the collections change in between).

import crypto from 'node:crypto'
import { all, get, run, now, parseJson } from './db.js'
import { inSeason } from './seasons.js'

const pad = (n) => String(n).padStart(2, '0')
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const lower = (s) => String(s || '').toLowerCase()

export function lastScheduled(rot, date) {
  const [h, m] = rot.time.split(':').map(Number)
  const d = new Date(date)
  d.setHours(h, m, 0, 0)
  if (rot.interval === 'weekly') {
    d.setDate(d.getDate() - ((d.getDay() - rot.weekday + 7) % 7))
    if (d > date) d.setDate(d.getDate() - 7)
  } else if (d > date) {
    d.setDate(d.getDate() - 1)
  }
  return d
}

export function nextScheduled(rot, date) {
  const d = lastScheduled(rot, date)
  d.setDate(d.getDate() + (rot.interval === 'weekly' ? 7 : 1))
  return d
}

export const rollKeyFor = (rot, date) => localDate(lastScheduled(rot, date))
export const slotCount = (template) => template.config.rows.filter((r) => r.kind === 'rotation').length

function prng(seedText) {
  let a = parseInt(crypto.createHash('sha256').update(seedText).digest('hex').slice(0, 8), 16)
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Weighted random order (Efraimidis–Spirakis): higher weight -> more likely early.
function weightedOrder(entries, rand) {
  return entries.map((e) => ({ e, k: Math.pow(rand() || 1e-9, 1 / e.weight) })).sort((a, b) => b.k - a.k).map((x) => x.e)
}

export function getRotationState(templateId) {
  const r = get('SELECT * FROM rotation_state WHERE template_id = ?', templateId)
  return r ? { ranked: parseJson(r.ranked, []), rolledAt: r.rolled_at, rollKey: r.roll_key, nonce: r.nonce } : { ranked: [], rolledAt: null, rollKey: null, nonce: 0 }
}

export function rotationHistory(templateId, limit = 50) {
  return all('SELECT collection_id, collection_name, shown_at FROM rotation_history WHERE template_id = ? ORDER BY id DESC LIMIT ?', templateId, limit)
}

// Names of the last n distinct collections shown, newest first.
function recentNames(templateId, n) {
  if (!n) return []
  const out = []
  for (const r of rotationHistory(templateId, 500)) {
    if (!out.includes(lower(r.collection_name))) out.push(lower(r.collection_name))
    if (out.length >= n) break
  }
  return out
}

async function rankPool(template, ctx, { seed, recent }) {
  const rand = prng(seed)
  const available = []
  for (const p of template.config.rotation.pool) {
    const c = ctx.find({ id: p.collectionId, name: p.collectionName })
    if (c && (await ctx.usable(c)) && !available.some((a) => a.id === c.id)) available.push({ id: c.id, name: c.name, weight: p.weight })
  }
  const fresh = available.filter((a) => !recent.includes(lower(a.name)))
  // recently shown ones go last, the longest ago first, so a too small pool still fills its slots
  const repeat = available.filter((a) => recent.includes(lower(a.name))).sort((a, b) => recent.indexOf(lower(b.name)) - recent.indexOf(lower(a.name)))
  return [...weightedOrder(fresh, rand), ...repeat]
}

/**
 * Seasonal collections active on `date`. Today: the collection must exist and have items (and, with a user, be
 * visible enough). Future days: a known season window decides (template window first, else Ultimate Collections');
 * without a window the collection is assumed to stay as it is today.
 */
export async function activeSeasonals(seasonalEntries, ctx, { date, today, userId = null, minRatio = 0.5 }) {
  const out = []
  for (const s of seasonalEntries) {
    const c = ctx.find({ name: s.collectionName })
    const window = s.season?.from ? s.season : c?.uc?.season || null
    const on = window ? inSeason(window, date) : null
    if (on === false) continue
    if (today || on === null) {
      if (await ctx.usable(c, userId, minRatio)) out.push({ collection: c, name: c.name, predicted: !today })
    } else {
      // In season that day. Ultimate Collections creates it on the first day, so it may not exist yet.
      const usable = c?.id && (await ctx.usable(c, userId, minRatio))
      out.push({ collection: usable ? c : null, name: usable ? c.name : s.collectionName, predicted: true })
    }
  }
  return out
}

export function isRollDue(template, date = new Date()) {
  const rot = template.config.rotation
  if (!rot.enabled || !slotCount(template)) return false
  return getRotationState(template.id).rollKey !== rollKeyFor(rot, date)
}

export async function rollTemplate(template, ctx, { date = new Date(), manual = false } = {}) {
  const rot = template.config.rotation
  const st = getRotationState(template.id)
  const nonce = st.nonce + (manual ? 1 : 0)
  const key = rollKeyFor(rot, date)
  const ranked = await rankPool(template, ctx, { seed: `${template.id}|${key}|${nonce}`, recent: recentNames(template.id, rot.avoidLastN) })
  const seasonal = await activeSeasonals(rot.seasonal, ctx, { date, today: true })
  const shown = ranked.slice(0, Math.max(0, slotCount(template) - seasonal.length))
  run(
    `INSERT INTO rotation_state (template_id, ranked, rolled_at, roll_key, nonce) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(template_id) DO UPDATE SET ranked = excluded.ranked, rolled_at = excluded.rolled_at, roll_key = excluded.roll_key, nonce = excluded.nonce`,
    template.id, JSON.stringify(ranked), now(), key, nonce,
  )
  const ts = now()
  for (const c of shown) run('INSERT INTO rotation_history (template_id, collection_id, collection_name, shown_at) VALUES (?, ?, ?, ?)', template.id, c.id, c.name, ts)
  return { ranked, shown, seasonal }
}

// The ranking in effect on `date`: the stored one, or the rolls between now and then simulated with the same seeds.
export async function rankedFor(template, ctx, date) {
  const rot = template.config.rotation
  const st = getRotationState(template.id)
  if (!rot.enabled) {
    const out = []
    for (const p of rot.pool) {
      const c = ctx.find({ id: p.collectionId, name: p.collectionName })
      if (c && (await ctx.usable(c))) out.push({ id: c.id, name: c.name, weight: p.weight })
    }
    return out
  }
  const target = rollKeyFor(rot, date)
  if (st.rollKey === target) return st.ranked
  let history = recentNames(template.id, 500)
  let ranked = st.ranked
  let t = st.rollKey ? nextScheduled(rot, new Date()) : lastScheduled(rot, new Date())
  for (let guard = 0; t <= date && guard < 120; guard++) {
    const key = rollKeyFor(rot, t)
    ranked = await rankPool(template, ctx, { seed: `${template.id}|${key}|${st.nonce}`, recent: history.slice(0, rot.avoidLastN) })
    const seasonal = await activeSeasonals(rot.seasonal, ctx, { date: t, today: false })
    const shown = ranked.slice(0, Math.max(0, slotCount(template) - seasonal.length))
    history = [...shown.map((c) => lower(c.name)), ...history.filter((n) => !shown.some((c) => lower(c.name) === n))]
    t = nextScheduled(rot, t)
  }
  return ranked
}

/** The collections for one user's rotation slots: active seasonal ones first, then the ranking. */
export async function fillSlots(template, ctx, { userId, ranked, seasonal }) {
  const slots = slotCount(template)
  const minRatio = template.config.rotation.minVisibleRatio
  const fixed = new Set(template.config.rows.filter((r) => r.kind === 'collection' || r.kind === 'seasonal').map((r) => ctx.find({ id: r.collectionId, name: r.collectionName })?.id).filter(Boolean))
  const out = []
  for (const s of seasonal) {
    if (out.length >= slots) break
    if (s.collection && fixed.has(s.collection.id)) continue
    out.push({ source: 'seasonal', collection: s.collection, name: s.name, predicted: s.predicted })
  }
  for (const r of ranked) {
    if (out.length >= slots) break
    const c = ctx.find({ id: r.id, name: r.name })
    if (!c || fixed.has(c.id) || out.some((o) => o.collection?.id === c.id)) continue
    if (await ctx.usable(c, userId, minRatio)) out.push({ source: 'rotation', collection: c, name: c.name })
  }
  return out
}
