import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'egm-unit-'))

const { patternRegex } = await import('../server/aperture.js')
const { inSeason, parseUcSeason } = await import('../server/seasons.js')
const { lastScheduled, nextScheduled } = await import('../server/rotation.js')

test('name pattern: separators and case are flexible', () => {
  const rx = patternRegex('Für dich ausgewählt {username} {type}', 'Filme', 'Serien')
  for (const name of ['Für dich ausgewählt Emre Filme', 'für dich ausgewählt – Emre – Filme', 'Für dich ausgewählt: Emre Serien', 'Für  dich ausgewählt Emre West Filme']) {
    const m = rx.exec(name)
    assert.ok(m, name)
  }
  assert.equal(rx.exec('Für dich ausgewählt Emre West Filme').groups.username, 'Emre West')
  assert.equal(rx.exec('Für dich ausgewählt Emre Serien').groups.type, 'Serien')
  assert.equal(rx.exec('Filme'), null)
  assert.equal(rx.exec('Für dich ausgewählt Emre Musik'), null)
})

test('season windows, including the year wrap', () => {
  const d = (s) => new Date(`${s}T12:00:00`)
  assert.equal(inSeason({ from: '12-01', to: '12-26' }, d('2026-12-10')), true)
  assert.equal(inSeason({ from: '12-01', to: '12-26' }, d('2026-12-27')), false)
  assert.equal(inSeason({ from: '12-26', to: '01-04' }, d('2027-01-02')), true)
  assert.equal(inSeason({ from: '12-26', to: '01-04' }, d('2026-11-30')), false)
  assert.equal(inSeason({ from: '', to: '' }, d('2026-11-30')), null)
})

test('Ultimate Collections season label', () => {
  assert.deepEqual(parseUcSeason('Oct 1 – Oct 31'), { from: '10-01', to: '10-31' })
  assert.deepEqual(parseUcSeason('Dec 26 – Jan 4'), { from: '12-26', to: '01-04' })
  assert.equal(parseUcSeason(null), null)
})

test('rotation schedule: daily and weekly', () => {
  const daily = { interval: 'daily', time: '04:00', weekday: 1 }
  const at = new Date('2026-10-28T03:00:00')
  assert.equal(lastScheduled(daily, at).toString(), new Date('2026-10-27T04:00:00').toString())
  assert.equal(nextScheduled(daily, at).toString(), new Date('2026-10-28T04:00:00').toString())
  const weekly = { interval: 'weekly', time: '06:30', weekday: 1 } // Monday
  const wed = new Date('2026-10-28T10:00:00') // Wednesday
  assert.equal(lastScheduled(weekly, wed).toString(), new Date('2026-10-26T06:30:00').toString())
  assert.equal(nextScheduled(weekly, wed).toString(), new Date('2026-11-02T06:30:00').toString())
})
