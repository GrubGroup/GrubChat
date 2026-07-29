// Build the synthetic-but-grounded restaurant catalog from REAL Bay Area data.
//
// Source: prisma/osm_source.json — real OpenStreetMap restaurants (real names,
// real streets, real house numbers, real coordinates, real cuisines) snapshotted
// by scripts/fetch_osm_restaurants.mjs. This script is a DETERMINISTIC transform
// off that snapshot (no network): it maps each real cuisine onto the region-based
// controlled vocabulary, balances the count across areas, and layers on the two
// fields OSM does not carry — dietary accommodations and a price — synthesized
// with a seeded PRNG so re-runs are identical.
//
// Why synthesize dietary/price: the AI retriever applies three hard AND filters —
// dietary superset, budget cap, and a geo bounding box (retriever.py). Real OSM
// data has almost no dietary/price tags, so a group could never match. We spread
// the controlled dietary tags and price bands across every area so the
// orchestrator always has real, dispersed choices to reconcile a whole group.
//
// Output: prisma/generated_restaurants.json (imported by seed.mjs, appended to
// the ~90 curated real restaurants; seed.mjs dedupes generated names against the
// curated ones). Run: `bun scripts/generate_restaurants.mjs` from backend/gateway/.
//
// Tag conventions (MUST match frontend/src/constants/dietary.ts + retriever):
//   cuisine_tags: region-based cuisines ONLY (e.g. 'italian', 'mexican',
//                 'ethiopian') — never a style/vibe word like 'casual' or
//                 'seafood'. Up to two tags: a primary region + optional regional
//                 sub-cuisine (e.g. 'chinese' + 'cantonese'), both region-based.
//   dietary_tags: controlled hyphenated vocabulary ONLY — a diet/allergen the
//                 restaurant can accommodate:
//                   'vegetarian' | 'vegan' | 'pescetarian' | 'halal' | 'kosher'
//                   | 'gluten-free' | 'dairy-free' | 'nut-free' | 'egg-free'
//                   | 'shellfish-free' | 'soy-free'
//
// Restaurant data © OpenStreetMap contributors, ODbL.

import { readFileSync, writeFileSync } from 'node:fs'
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
const rng = makeRng(20260729)
const pick = (arr) => arr[Math.floor(rng() * arr.length)]

// Cap per area so no single dense neighborhood swamps the catalog. Set high
// enough to reach the ~2,000-restaurant target: of the 19 anchor areas only
// SF's three mega-dense ones (Mission 385, SoMa 330, Richmond 258 mappable
// venues) get trimmed; every other area is kept in FULL so each locale carries
// its real complement for the retriever's geo-bounding-box search — a group
// anywhere in the Bay still has a deep, dispersed local pool to reconcile.
const PER_AREA_CAP = 280

// ---------------------------------------------------------------------------
// Real OSM cuisine token -> region-based tag. OSM cuisines are messy, ';'/','
// -separated, and mix in styles ("burger", "coffee_shop", "breakfast"). We keep
// only region-based tags and map dish/style words onto their region where the
// mapping is unambiguous (pizza->italian, sushi->japanese, pho->vietnamese, ...).
// Tokens NOT in this map are dropped; a restaurant with zero region tags after
// mapping is dropped entirely (that's how cafes / dessert / juice bars fall out).
// ---------------------------------------------------------------------------
const REGION_MAP = {
  // East & Southeast Asian
  chinese: 'chinese', cantonese: 'cantonese', szechuan: 'sichuan', sichuan: 'sichuan',
  hunan: 'hunan', shanghai: 'shanghainese', shanghainese: 'shanghainese', mandarin: 'chinese',
  hong_kong: 'cantonese', dim_sum: 'chinese', dumpling: 'chinese', hotpot: 'chinese',
  hot_pot: 'chinese', malatang: 'chinese', teochew: 'chinese',
  japanese: 'japanese', sushi: 'japanese', ramen: 'japanese', izakaya: 'japanese',
  yakitori: 'japanese', robatayaki: 'japanese', robata: 'japanese', soba: 'japanese',
  onigiri: 'japanese', donburi: 'japanese', teppanyaki: 'japanese', hibachi: 'japanese',
  okinawan: 'japanese', nabe: 'japanese',
  thai: 'thai', vietnamese: 'vietnamese', pho: 'vietnamese', korean: 'korean', banchan: 'korean',
  taiwanese: 'taiwanese', filipino: 'filipino', indonesian: 'indonesian', malaysian: 'malaysian',
  burmese: 'burmese', shan: 'burmese', cambodian: 'cambodian', lao: 'lao', mongolian: 'mongolian',
  tibetan: 'tibetan', nepalese: 'nepalese', nepali: 'nepalese', himalayan: 'nepalese',
  // South Asian
  indian: 'indian', south_indian: 'south-indian', north_indian: 'north-indian', punjabi: 'punjabi',
  goan: 'goan', pakistani: 'pakistani', sri_lankan: 'sri-lankan',
  // Americas
  american: 'american', burger: 'american', new_american: 'american', southern: 'american',
  soul: 'american', cajun: 'american', creole: 'american', louisiana: 'american',
  hawaiian: 'american', barbecue: 'american', bbq: 'american', steak_house: 'american',
  steak: 'american', diner: 'american', californian: 'american', california: 'american',
  seafood: 'american', cheesesteak: 'american', chicken: 'american',
  mexican: 'mexican', tacos: 'mexican', taco: 'mexican', taqueria: 'mexican', burrito: 'mexican',
  'tex-mex': 'tex-mex', oaxacan: 'oaxacan', yucatecan: 'yucatecan', carnitas: 'mexican',
  latin_american: 'latin-american', salvadoran: 'salvadoran', salvadorian: 'salvadoran',
  pupusa: 'salvadoran', guatemalan: 'guatemalan', nicaraguan: 'nicaraguan', honduran: 'honduran',
  colombian: 'colombian', venezuelan: 'venezuelan', argentinian: 'argentine', argentine: 'argentine',
  brazilian: 'brazilian', peruvian: 'peruvian', chilean: 'chilean',
  caribbean: 'caribbean', cuban: 'cuban', jamaican: 'jamaican', haitian: 'haitian',
  puerto_rican: 'puerto-rican',
  // European
  italian: 'italian', pizza: 'italian', pasta: 'italian', sicilian: 'sicilian', tuscan: 'tuscan',
  roman: 'roman', neapolitan: 'neapolitan', napoletana: 'neapolitan', pinsa: 'italian',
  french: 'french', crepe: 'french', bistro: 'french', provencal: 'provencal', alsatian: 'alsatian',
  spanish: 'spanish', tapas: 'spanish', basque: 'basque', catalan: 'catalan', andalusian: 'andalusian',
  greek: 'greek', souvlaki: 'greek', gyros: 'greek',
  german: 'german', austrian: 'austrian', swiss: 'swiss', belgian: 'belgian', portuguese: 'portuguese',
  irish: 'irish', british: 'british', polish: 'polish', russian: 'russian', ukrainian: 'ukrainian',
  scandinavian: 'scandinavian', hungarian: 'hungarian', czech: 'czech', georgian: 'georgian',
  uzbek: 'uzbek',
  // Mediterranean / Middle Eastern / African
  mediterranean: 'mediterranean', middle_eastern: 'middle-eastern', arab: 'middle-eastern',
  lebanese: 'lebanese', turkish: 'turkish', persian: 'persian', northern_iranian: 'persian',
  israeli: 'israeli', palestinian: 'palestinian', syrian: 'syrian', yemeni: 'yemeni',
  kurdish: 'kurdish', kebab: 'middle-eastern', shawarma: 'middle-eastern', falafel: 'middle-eastern',
  afghan: 'afghan', kabab: 'middle-eastern', egyptian: 'egyptian',
  ethiopian: 'ethiopian', eritrean: 'eritrean', east_african: 'east-african', moroccan: 'moroccan',
  tunisian: 'tunisian', algerian: 'algerian', nigerian: 'nigerian', senegalese: 'senegalese',
  west_african: 'west-african', tanzanian: 'tanzanian', african: 'african',
}

// Region tags that are a regional SUB-cuisine (only ever used as the 2nd tag,
// never counted as the primary that keeps a restaurant in the set).
const SUB_REGIONS = new Set([
  'cantonese', 'sichuan', 'hunan', 'shanghainese', 'oaxacan', 'yucatecan', 'tex-mex',
  'south-indian', 'north-indian', 'punjabi', 'goan', 'sicilian', 'tuscan', 'roman',
  'neapolitan', 'provencal', 'alsatian', 'basque', 'catalan', 'andalusian', 'eritrean',
  'east-african', 'west-african',
])

// Map a raw OSM cuisine string to up to two region tags: [primary, sub?].
function mapCuisine(raw) {
  const tokens = String(raw).toLowerCase().split(/[;,/]/).map((t) => t.trim()).filter(Boolean)
  const mapped = []
  for (const tok of tokens) {
    const region = REGION_MAP[tok] || REGION_MAP[tok.replace(/\s+/g, '_')]
    if (region && !mapped.includes(region)) mapped.push(region)
  }
  if (mapped.length === 0) return null
  const primary = mapped.find((t) => !SUB_REGIONS.has(t)) ?? mapped[0]
  const sub = mapped.find((t) => t !== primary)
  return sub ? [primary, sub] : [primary]
}

// ---------------------------------------------------------------------------
// Dietary — the 11 hyphenated controlled tokens. A weighted pool controls base
// frequency (common accommodations often, rare ones like kosher occasionally);
// a light per-cuisine affinity makes the common real-world pairings show up
// (halal at Middle Eastern / Pakistani spots, vegetarian/vegan at Indian /
// Ethiopian) without starving coverage — random fills still reach every tag.
// ---------------------------------------------------------------------------
const DIETARY_WEIGHTED = [
  ...Array(9).fill('vegetarian'),
  ...Array(7).fill('vegan'),
  ...Array(7).fill('gluten-free'),
  ...Array(6).fill('dairy-free'),
  ...Array(5).fill('pescetarian'),
  ...Array(5).fill('halal'),
  ...Array(4).fill('nut-free'),
  ...Array(4).fill('shellfish-free'),
  ...Array(3).fill('egg-free'),
  ...Array(3).fill('soy-free'),
  ...Array(2).fill('kosher'),
]
const AFFINITY = {
  halal: ['middle-eastern', 'lebanese', 'turkish', 'persian', 'afghan', 'pakistani', 'moroccan',
    'yemeni', 'syrian', 'palestinian', 'egyptian', 'kurdish', 'indian'],
  vegetarian: ['indian', 'ethiopian', 'mediterranean', 'south-indian', 'nepalese', 'greek'],
  vegan: ['ethiopian', 'indian', 'thai', 'vietnamese', 'mediterranean'],
  pescetarian: ['japanese', 'mediterranean', 'peruvian', 'greek', 'portuguese', 'italian', 'spanish'],
}

// The six allergen "free-from" tags (vs. the lifestyle/religious diet tags). These
// are what the retriever superset-filters on when a group MIXES allergies, so a
// share of restaurants must accommodate SEVERAL at once — otherwise e.g. a
// nut-free + shellfish-free group matches almost nothing. Real allergen-conscious
// kitchens do exactly this (one careful kitchen handles many allergens together),
// so we model ~35% of spots as allergen-aware and give them a cluster.
const ALLERGEN_TAGS = ['gluten-free', 'dairy-free', 'nut-free', 'egg-free', 'shellfish-free', 'soy-free']

function dietaryTags(primaryCuisine) {
  const tags = new Set()

  // Affinity seed: ~55% of the time, seed a cuisine-typical DIET tag first
  // (halal at Middle Eastern / Pakistani, vegetarian/vegan at Indian / Ethiopian).
  if (rng() < 0.55) {
    const candidates = Object.entries(AFFINITY)
      .filter(([, cuisines]) => cuisines.includes(primaryCuisine))
      .map(([tag]) => tag)
    if (candidates.length) tags.add(pick(candidates))
  }

  // Allergen-aware kitchens (~35%): carry a CLUSTER of 2–3 allergen tags together
  // so mixed-allergy groups have real, dispersed matches in every area.
  if (rng() < 0.35) {
    const pool = [...ALLERGEN_TAGS]
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      ;[pool[i], pool[j]] = [pool[j], pool[i]]
    }
    const k = rng() < 0.6 ? 2 : 3
    for (let i = 0; i < k; i++) tags.add(pool[i])
  }

  // Fill to a base density floor from the weighted pool (keeps single-tag spots
  // common and every tag reachable). ~42% one, ~36% two, ~16% three, ~6% four —
  // a floor, so an allergen cluster may already put a spot above it.
  const r = rng()
  const target = r < 0.42 ? 1 : r < 0.78 ? 2 : r < 0.94 ? 3 : 4
  while (tags.size < target) tags.add(pick(DIETARY_WEIGHTED))
  return [...tags]
}

// Price bands (per-person USD) — weighted toward mid-range with a spread wide
// enough that a min-budget cap never empties an area and upscale groups match.
const PRICE_WEIGHTED = [
  ...Array(3).fill(12), ...Array(5).fill(16), ...Array(6).fill(20), ...Array(6).fill(25),
  ...Array(5).fill(30), ...Array(4).fill(38), ...Array(3).fill(45), ...Array(2).fill(55),
  ...Array(1).fill(70), ...Array(1).fill(90),
]

const HOURS = [
  'Mon-Sun 11:00-22:00', 'Tue-Sun 17:00-22:00', 'Mon-Sun 11:00-21:00',
  'Wed-Sun 12:00-21:00', 'Mon-Sat 11:00-20:00', 'Mon-Sun 08:00-15:00',
  'Tue-Sun 11:30-21:30', 'Mon-Sun 10:00-23:00', 'Wed-Mon 17:00-23:00',
  'Thu-Mon 09:00-14:00', 'Mon-Fri 11:00-15:00',
]

// A few simple description forms. Real street + real city keep them accurate and
// naturally varied; the point is a readable line, not a generated menu.
const title = (s) => s.replace(/\b\w/g, (m) => m.toUpperCase())
const DESC_FORMS = [
  (c, street, city) => `${title(c)} spot on ${street} in ${city}.`,
  (c, street, city) => `${title(c)} kitchen in ${city}, tucked onto ${street}.`,
  (c, street) => `Neighborhood ${c} restaurant on ${street}.`,
  (c, street, city) => `${title(c)} favorite on ${street}, ${city}.`,
]

// ---- load real source + transform ----
const __dirname = dirname(fileURLToPath(import.meta.url))
const source = JSON.parse(readFileSync(join(__dirname, '..', 'prisma', 'osm_source.json'), 'utf8'))

// Group by area, dropping rows whose cuisine can't be mapped to a region.
const byArea = new Map()
for (const r of source) {
  const cuisine = mapCuisine(r.cuisine)
  if (!cuisine) continue
  if (!byArea.has(r.area)) byArea.set(r.area, [])
  byArea.get(r.area).push({ ...r, cuisine })
}

const restaurants = []
const seenKeys = new Set()
const perAreaStats = {}

// Stable area order (as first seen in the snapshot) → deterministic output.
for (const [area, rows] of byArea) {
  // Deterministic order: sort by a stable key, then seeded-shuffle so the cap
  // takes a varied cross-section (not just alphabetical) of each dense area.
  rows.sort((a, b) => `${a.name}|${a.housenumber}|${a.street}`.localeCompare(`${b.name}|${b.housenumber}|${b.street}`))
  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[rows[i], rows[j]] = [rows[j], rows[i]]
  }

  perAreaStats[area] = 0
  for (const r of rows) {
    if (perAreaStats[area] >= PER_AREA_CAP) break
    // Collapse only EXACT-duplicate venues (same name + address — e.g. a row that
    // surfaced in two overlapping bboxes). DISTINCT real locations of a chain
    // (same name, different address) are kept: each is a real venue anchoring a
    // real area, which widens geographic coverage. seed.mjs additionally drops any
    // name that collides with a curated entry.
    const key = `${r.name}|${r.housenumber}|${r.street}`
    if (seenKeys.has(key)) continue
    seenKeys.add(key)

    const primary = r.cuisine[0]
    const cuisineLabel = primary.replace(/-/g, ' ')
    const zip = r.postcode ? ` ${r.postcode}` : ''
    restaurants.push({
      name: r.name,
      description: pick(DESC_FORMS)(cuisineLabel, r.street, r.city),
      cuisine_tags: r.cuisine,
      dietary_tags: dietaryTags(primary),
      price_avg: pick(PRICE_WEIGHTED),
      address: `${r.housenumber} ${r.street}, ${r.city}, CA${zip}`,
      lat: r.lat,
      long: r.lon,
      hours: pick(HOURS),
      avg_rating: Math.round((3.8 + rng() * 0.9) * 10) / 10, // 3.8–4.7
    })
    perAreaStats[area]++
  }
}

// ---- write output ----
const outPath = join(__dirname, '..', 'prisma', 'generated_restaurants.json')
writeFileSync(outPath, JSON.stringify(restaurants, null, 0))

// ---- report ----
console.log(`Generated ${restaurants.length} restaurants from ${source.length} real OSM rows across ${byArea.size} areas.`)
console.log('Per-area counts:', JSON.stringify(perAreaStats))
console.log(`Distinct names: ${new Set(restaurants.map((r) => r.name)).size} / ${restaurants.length}`)
console.log(`Distinct addresses: ${new Set(restaurants.map((r) => r.address)).size} / ${restaurants.length}`)
console.log(`Distinct descriptions: ${new Set(restaurants.map((r) => r.description)).size} / ${restaurants.length}`)
const tagCounts = {}
for (const r of restaurants) for (const t of r.dietary_tags) tagCounts[t] = (tagCounts[t] || 0) + 1
console.log('Global dietary-tag counts:', JSON.stringify(tagCounts))
const cuisineCounts = {}
for (const r of restaurants) cuisineCounts[r.cuisine_tags[0]] = (cuisineCounts[r.cuisine_tags[0]] || 0) + 1
console.log('Primary-cuisine spread:', Object.keys(cuisineCounts).length, 'cuisines')
const priceCounts = {}
for (const r of restaurants) priceCounts[r.price_avg] = (priceCounts[r.price_avg] || 0) + 1
console.log('Price-band counts:', JSON.stringify(priceCounts))
console.log(`Wrote ${outPath}`)
