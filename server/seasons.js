// Season windows 'MM-DD'..'MM-DD', both days included, may wrap the new year. Same rule as Ultimate Collections
// (Core/CollectionsConfig.cs Season.InSeason), so both tools agree on which day a season is on.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
const pad = (n) => String(n).padStart(2, '0')

export const mmddOf = (date) => `${pad(date.getMonth() + 1)}${pad(date.getDate())}`

export function inSeason(window, date) {
  if (!window?.from || !window?.to) return null
  const a = window.from.replace('-', '')
  const b = window.to.replace('-', '')
  const t = mmddOf(date)
  return a <= b ? a <= t && t <= b : t >= a || t <= b
}

// Ultimate Collections status label "Oct 1 – Oct 31" (Season.Describe, invariant culture) -> { from, to }.
export function parseUcSeason(label) {
  const m = /^([A-Za-z]{3})\s+(\d{1,2})\s*[–-]\s*([A-Za-z]{3})\s+(\d{1,2})$/.exec(String(label || '').trim())
  if (!m) return null
  const a = MONTHS[m[1].toLowerCase()]
  const b = MONTHS[m[3].toLowerCase()]
  if (!a || !b) return null
  return { from: `${pad(a)}-${pad(m[2])}`, to: `${pad(b)}-${pad(m[4])}` }
}
