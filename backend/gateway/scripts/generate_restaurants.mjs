// Generate ~900 synthetic Bay Area restaurants, ENGINEERED for 3-filter coverage.
//
// Why: the AI retriever applies three hard AND filters — dietary superset,
// budget cap, and a geo bounding box (retriever.py). For a group to match in a
// given area, that area must contain a spread of dietary options across price
// bands. Real OSM data leaves dietary tags too sparse, so we synthesize with
// deliberate coverage instead.
//
// Output: prisma/generated_restaurants.json (imported by seed.mjs, appended to
// the ~100 curated real restaurants). Run: `bun scripts/generate_restaurants.mjs`
// from backend/gateway/.
//
// Deterministic: a seeded PRNG keyed by index, so re-runs produce identical data
// (no Math.random churn). Not real places — names/addresses are fabricated;
// coordinates are jittered around real Bay Area anchors.

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// ---- deterministic PRNG (mulberry32) so output is stable across runs ----
function makeRng(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rng = makeRng(20260728)
const pick = (arr) => arr[Math.floor(rng() * arr.length)]
const round6 = (n) => Math.round(n * 1e6) / 1e6

// Controlled dietary vocab — MUST match member prefs + retriever expectations.
const DIETARY = [
  'vegetarian', 'vegan', 'gluten-free', 'dairy-free',
  'nut-free', 'halal', 'shellfish-free', 'kosher',
]
// Weight so common tags appear often, rare ones (kosher/shellfish-free) still
// show up a few times per area. Weighted pool for random draws.
const DIETARY_WEIGHTED = [
  ...Array(8).fill('vegetarian'),
  ...Array(6).fill('gluten-free'),
  ...Array(5).fill('vegan'),
  ...Array(4).fill('dairy-free'),
  ...Array(3).fill('halal'),
  ...Array(2).fill('nut-free'),
  ...Array(1).fill('shellfish-free'),
  ...Array(1).fill('kosher'),
]

// Price bands (per-person USD) — spread so a min-budget cap never empties an area.
const PRICE_BANDS = [12, 18, 25, 35, 45, 60, 75]

// Cuisines + name tokens for plausible synthetic names.
const CUISINES = [
  ['mexican', ['Taquería', 'Cocina', 'Cantina']],
  ['italian', ['Trattoria', 'Osteria', 'Cucina']],
  ['japanese', ['Sushi Bar', 'Izakaya', 'Ramen House']],
  ['chinese', ['Dumpling House', 'Kitchen', 'Wok']],
  ['thai', ['Thai Kitchen', 'Basil', 'Spice']],
  ['indian', ['Curry House', 'Tandoor', 'Masala']],
  ['vietnamese', ['Phở House', 'Saigon', 'Bánh Mì']],
  ['korean', ['BBQ House', 'Bibimbap', 'Seoul Kitchen']],
  ['mediterranean', ['Mezze', 'Olive', 'Taverna']],
  ['middle-eastern', ['Kebab House', 'Shawarma', 'Falafel']],
  ['american', ['Grill', 'Diner', 'Kitchen']],
  ['ethiopian', ['Injera', 'Blue Nile', 'Habesha']],
  ['french', ['Bistro', 'Brasserie', 'Café']],
  ['greek', ['Taverna', 'Souvlaki', 'Aegean']],
  ['pizza', ['Pizzeria', 'Slice', 'Forno']],
  ['vegan', ['Green Table', 'Plant', 'Root']],
  ['seafood', ['Fish House', 'Oyster Bar', 'Catch']],
  ['bbq', ['Smokehouse', 'Pit', 'Brisket']],
]
const NAME_ADJ = ['Golden', 'Blue', 'Little', 'Old', 'Sunny', 'Coastal', 'Urban',
  'Rustic', 'Modern', 'Corner', 'Garden', 'Family', 'Hidden', 'Bay', 'Wild']

// Bay Area anchor areas: [label, city, lat, lon]. Real centers; restaurants
// jitter within ~1.5mi so each area has a real geographic cluster.
const AREAS = [
  ['Mission', 'San Francisco', 37.7599, -122.4148],
  ['SoMa', 'San Francisco', 37.7785, -122.4056],
  ['Richmond', 'San Francisco', 37.7801, -122.4644],
  ['Sunset', 'San Francisco', 37.7519, -122.4936],
  ['North Beach', 'San Francisco', 37.8003, -122.4103],
  ['Hayes Valley', 'San Francisco', 37.7765, -122.4245],
  ['Downtown Oakland', 'Oakland', 37.8044, -122.2712],
  ['Temescal', 'Oakland', 37.8352, -122.2630],
  ['Berkeley', 'Berkeley', 37.8715, -122.2680],
  ['Palo Alto', 'Palo Alto', 37.4419, -122.1430],
  ['Mountain View', 'Mountain View', 37.3861, -122.0839],
  ['Sunnyvale', 'Sunnyvale', 37.3688, -122.0363],
  ['Downtown San Jose', 'San Jose', 37.3382, -121.8863],
  ['Santana Row', 'San Jose', 37.3210, -121.9486],
  ['Redwood City', 'Redwood City', 37.4852, -122.2364],
  ['San Mateo', 'San Mateo', 37.5630, -122.3255],
  ['Fremont', 'Fremont', 37.5485, -121.9886],
  ['San Rafael', 'San Rafael', 37.9735, -122.5311],
  ['Sausalito', 'Sausalito', 37.8591, -122.4853],
  ['Walnut Creek', 'Walnut Creek', 37.9101, -122.0652],
]

const HOURS = [
  'Mon-Sun 11:00-22:00', 'Tue-Sun 17:00-22:00', 'Mon-Sun 11:00-21:00',
  'Wed-Sun 12:00-21:00', 'Mon-Sat 11:00-20:00', 'Mon-Sun 08:00-15:00',
]

// Per-area count → ~900 across 20 areas = 45 each.
const PER_AREA = 45

function dietaryTags() {
  // Realistic density: ~60% one tag, ~30% two, ~10% three.
  const r = rng()
  const n = r < 0.6 ? 1 : r < 0.9 ? 2 : 3
  const tags = new Set()
  while (tags.size < n) tags.add(pick(DIETARY_WEIGHTED))
  return [...tags]
}

const usedNames = new Set()
function uniqueName(cuisineEntry, area) {
  const [, tokens] = cuisineEntry
  for (let i = 0; i < 12; i++) {
    const name = `${pick(NAME_ADJ)} ${pick(tokens)}`
    const key = `${name}|${area}`
    if (!usedNames.has(key)) { usedNames.add(key); return name }
  }
  // Fallback: append area to guarantee uniqueness.
  const name = `${pick(NAME_ADJ)} ${pick(tokens)} (${area})`
  usedNames.add(`${name}|${area}`)
  return name
}

const restaurants = []
let idx = 0
const perAreaStats = {}

for (const [label, city, alat, alon] of AREAS) {
  perAreaStats[label] = 0
  for (let i = 0; i < PER_AREA; i++) {
    idx++
    const cuisineEntry = pick(CUISINES)
    const cuisine = cuisineEntry[0]
    const name = uniqueName(cuisineEntry, label)
    // Jitter ~1.5mi: ~0.02 deg lat, scaled lon.
    const lat = round6(alat + (rng() - 0.5) * 0.04)
    const lon = round6(alon + (rng() - 0.5) * 0.05)
    const price = pick(PRICE_BANDS)
    const rating = Math.round((3.8 + rng() * 0.9) * 10) / 10 // 3.8–4.7
    const tags = dietaryTags()
    const cuisineTags = [cuisine]
    if (rng() < 0.4) cuisineTags.push(pick(['casual', 'family-friendly', 'upscale', 'quick-bite']))

    restaurants.push({
      name,
      description: `A ${cuisine} spot in ${label}, ${city}.`,
      cuisine_tags: cuisineTags,
      dietary_tags: tags,
      price_avg: price,
      address: `${100 + idx} ${label} Ave, ${city}, CA`,
      lat,
      long: lon,
      hours: pick(HOURS),
      avg_rating: rating,
    })
    perAreaStats[label]++
  }
}

// ---- write output ----
const __dirname = dirname(fileURLToPath(import.meta.url))
const outPath = join(__dirname, '..', 'prisma', 'generated_restaurants.json')
writeFileSync(outPath, JSON.stringify(restaurants, null, 0))

// ---- report ----
console.log(`Generated ${restaurants.length} synthetic restaurants across ${AREAS.length} areas.`)
console.log('Per-area counts:', JSON.stringify(perAreaStats))
const tagCounts = {}
for (const r of restaurants) for (const t of r.dietary_tags) tagCounts[t] = (tagCounts[t] || 0) + 1
console.log('Global dietary-tag counts:', JSON.stringify(tagCounts))
const priceCounts = {}
for (const r of restaurants) priceCounts[r.price_avg] = (priceCounts[r.price_avg] || 0) + 1
console.log('Price-band counts:', JSON.stringify(priceCounts))
console.log(`Wrote ${outPath}`)
