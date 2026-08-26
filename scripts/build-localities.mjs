import { readFileSync, writeFileSync } from 'node:fs'

const SP = 'C:/Users/Chris/AppData/Local/Temp/claude/C--Users-Chris-Desktop/23d4e26d-e28b-4202-912f-9d6619ca961d/scratchpad/'
const rows = JSON.parse(readFileSync(SP + 'aupost.json', 'utf8'))

const STATES = new Set(['QLD', 'NSW', 'VIC', 'SA', 'WA', 'TAS', 'NT', 'ACT'])

/* "NEW FARM" -> "New Farm", "ST MARYS" -> "St Marys", "O'CONNOR" -> "O'Connor". */
const titleCase = (s) =>
  s
    .toLowerCase()
    .replace(/(^|[\s('\-\/])([a-z])/g, (_, pre, ch) => pre + ch.toUpperCase())
    .replace(/\bMc([a-z])/g, (_, ch) => 'Mc' + ch.toUpperCase())

const seen = new Map()
let skipped = { type: 0, coords: 0, state: 0, dupe: 0, postal: 0 }

/*
 * Postal facilities wearing a suburb's name. "Maroochydore Bc" is a business centre and
 * "Albany Dc" a delivery centre: mail sorting sites, not places anyone lives or works. They sit
 * in the file as ordinary delivery areas and they crowd out the real suburb in the results,
 * which is the opposite of the point.
 */
const POSTAL_FACILITY = /[ ](Bc|Dc|Mc|Msc|Delivery Centre|Business Centre|Mail Centre)$/i

for (const r of rows) {
  // Post office boxes and LVR (large volume receivers) are not places anyone lives or works.
  if (r.type && r.type !== 'Delivery Area') { skipped.type++; continue }
  if (!STATES.has(r.state)) { skipped.state++; continue }

  const lat = Number(r.Lat_precise) || Number(r.lat)
  const lng = Number(r.Long_precise) || Number(r.long)
  // Australia's bounding box, loosely. Catches the zero-coordinate rows and anything transposed.
  if (!lat || !lng || lat > -9 || lat < -44 || lng < 112 || lng > 154) { skipped.coords++; continue }

  const name = titleCase(String(r.locality || '').trim())
  const postcode = String(r.postcode || '').padStart(4, '0')
  if (!name || !/^\d{4}$/.test(postcode)) { skipped.coords++; continue }

  if (POSTAL_FACILITY.test(name)) { skipped.postal++; continue }

  const key = `${name.toLowerCase()}|${r.state}|${postcode}`
  if (seen.has(key)) { skipped.dupe++; continue }
  seen.set(key, { name, state: r.state, postcode, lat: Number(lat.toFixed(4)), lng: Number(lng.toFixed(4)) })
}

const out = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.state.localeCompare(b.state))
writeFileSync(SP + 'au-localities.json', JSON.stringify(out))

console.log('kept:', out.length, '| skipped:', JSON.stringify(skipped))
console.log('bytes:', JSON.stringify(out).length)
const find = (n) => out.filter((s) => s.name.toLowerCase() === n.toLowerCase()).map((s) => `${s.name}, ${s.state} ${s.postcode}`)
for (const n of ['Maroochydore', 'Buderim', 'Noosa Heads', 'Wandi', 'Baldivis', 'Coomera', 'Truganina', 'Kellyville Ridge'])
  console.log('  ', n, '->', find(n).join(' / ') || 'MISSING')
