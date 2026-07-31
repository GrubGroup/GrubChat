// Pull REAL Bay Area restaurants from OpenStreetMap (Overpass API) and snapshot
// the fields we can trust to a JSON file. This is the "real data" source for
// generate_restaurants.mjs — real names, real streets, real house numbers,
// real coordinates, real cuisines. OSM has no dietary/price data, so those are
// synthesized deterministically downstream (see generate_restaurants.mjs).
//
// Run once (network required): `bun scripts/fetch_osm_restaurants.mjs` from
// backend/gateway/. Writes prisma/osm_source.json. Re-run to refresh the
// snapshot; generation itself stays offline + deterministic off that file.
//
// Data © OpenStreetMap contributors, ODbL (https://www.openstreetmap.org/copyright).

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Bay Area anchor areas, dispersed Marin → San Jose. Labels match the areas the
// generator groups by. bbox radius ~1.5–2mi around each [lat, lon].
const AREAS = [
  { label: 'Mission', city: 'San Francisco', lat: 37.7599, lon: -122.4148 },
  { label: 'SoMa', city: 'San Francisco', lat: 37.7785, lon: -122.4056 },
  { label: 'Richmond', city: 'San Francisco', lat: 37.7801, lon: -122.4644 },
  { label: 'Sunset', city: 'San Francisco', lat: 37.7519, lon: -122.4936 },
  { label: 'North Beach', city: 'San Francisco', lat: 37.8003, lon: -122.4103 },
  { label: 'Hayes Valley', city: 'San Francisco', lat: 37.7765, lon: -122.4245 },
  { label: 'Downtown Oakland', city: 'Oakland', lat: 37.8044, lon: -122.2712 },
  { label: 'Temescal', city: 'Oakland', lat: 37.8352, lon: -122.2630 },
  { label: 'Berkeley', city: 'Berkeley', lat: 37.8715, lon: -122.2680 },
  { label: 'Palo Alto', city: 'Palo Alto', lat: 37.4419, lon: -122.1430 },
  { label: 'Mountain View', city: 'Mountain View', lat: 37.3861, lon: -122.0839 },
  { label: 'Sunnyvale', city: 'Sunnyvale', lat: 37.3688, lon: -122.0363 },
  { label: 'Downtown San Jose', city: 'San Jose', lat: 37.3382, lon: -121.8863 },
  { label: 'Santana Row', city: 'San Jose', lat: 37.3210, lon: -121.9486 },
  { label: 'Redwood City', city: 'Redwood City', lat: 37.4852, lon: -122.2364 },
  { label: 'San Mateo', city: 'San Mateo', lat: 37.5630, lon: -122.3255 },
  { label: 'Fremont', city: 'Fremont', lat: 37.5485, lon: -121.9886 },
  { label: 'San Rafael', city: 'San Rafael', lat: 37.9735, lon: -122.5311 },
  { label: 'Sausalito', city: 'Sausalito', lat: 37.8591, lon: -122.4853 },
  { label: 'Walnut Creek', city: 'Walnut Creek', lat: 37.9101, lon: -122.0652 },
]

const D_LAT = 0.02
const D_LON = 0.025
const OVERPASS = 'https://overpass-api.de/api/interpreter'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function query(area) {
  const s = (area.lat - D_LAT).toFixed(5)
  const w = (area.lon - D_LON).toFixed(5)
  const n = (area.lat + D_LAT).toFixed(5)
  const e = (area.lon + D_LON).toFixed(5)
  const bbox = `${s},${w},${n},${e}`
  return `[out:json][timeout:60];(node["amenity"="restaurant"](${bbox});way["amenity"="restaurant"](${bbox}););out tags center;`
}

async function fetchArea(area, attempt = 1) {
  const url = `${OVERPASS}?data=${encodeURIComponent(query(area))}`
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      // Overpass returns 406 without a proper UA / Accept on some clients.
      'User-Agent': 'GrubGroup-seed/1.0 (restaurant mock data)',
      Accept: 'application/json',
    },
  })
  if (!res.ok) {
    if (attempt < 3) {
      console.warn(`  ${area.label}: HTTP ${res.status}, retrying (${attempt})...`)
      await sleep(5000)
      return fetchArea(area, attempt + 1)
    }
    throw new Error(`${area.label}: HTTP ${res.status}`)
  }
  return res.json()
}

const seenIds = new Set()
const out = []

for (const area of AREAS) {
  const data = await fetchArea(area)
  let kept = 0
  for (const el of data.elements) {
    const id = `${el.type}/${el.id}`
    if (seenIds.has(id)) continue // dedupe across overlapping bboxes
    const t = el.tags || {}
    const name = (t.name || '').trim()
    const street = (t['addr:street'] || '').trim()
    const housenumber = (t['addr:housenumber'] || '').trim()
    // Require a real name + real street + house number so the address is usable.
    if (!name || !street || !housenumber) continue
    const lat = el.lat ?? el.center?.lat
    const lon = el.lon ?? el.center?.lon
    if (lat == null || lon == null) continue
    seenIds.add(id)
    out.push({
      area: area.label,
      city: t['addr:city'] || area.city,
      name,
      cuisine: (t.cuisine || '').trim(),
      housenumber,
      street,
      postcode: (t['addr:postcode'] || '').trim(),
      lat: Math.round(lat * 1e6) / 1e6,
      lon: Math.round(lon * 1e6) / 1e6,
    })
    kept++
  }
  console.log(`${area.label}: kept ${kept} (with name+street+housenumber)`)
  await sleep(1500) // be polite to the public Overpass instance
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const outPath = join(__dirname, '..', 'prisma', 'osm_source.json')
writeFileSync(outPath, JSON.stringify(out, null, 0))
console.log(`\nWrote ${out.length} real restaurants to ${outPath}`)
const cuisines = {}
for (const r of out) cuisines[r.cuisine || '(none)'] = (cuisines[r.cuisine || '(none)'] || 0) + 1
console.log('Raw cuisine values:', JSON.stringify(Object.fromEntries(Object.entries(cuisines).sort((a, b) => b[1] - a[1]))))
