// Cuisine stock photography — the pools behind every restaurant "banner" in the
// app (Explore cards + detail modal, Top-picks results, Events rows + hero).
//
// WHAT THESE ARE (and are NOT): generic, CC-licensed photos of the FOOD a cuisine
// is known for. They are NOT photographs of the specific venue — the `Restaurant`
// row carries no image column and the catalog is seeded, so there is nothing real
// to show. That is exactly why the pick is RANDOMIZED per preview rather than
// stored: a stable id→photo map would read as "this restaurant looks like this",
// while a rotating illustrative image reads as decoration. For the same reason the
// <img> is rendered decorative (empty alt) by `RestaurantImage` — a screen reader
// must not announce it as a picture of the place.
//
// FILES: every key below has exactly `IMAGES_PER_CUISINE` photos committed at
//   frontend/public/media/cuisines/<key>/<key>-<n>.jpg
// so a URL is derivable from (key, n) with no manifest fetch at runtime. Vite
// copies `public/` verbatim into `dist/`, so the same paths serve from the Render
// static site. Provenance + licence for every file is in that folder's
// ATTRIBUTION.md / credits.json, written by
// `frontend/scripts/fetch-cuisine-images.ts` (re-run it to refresh the set).
//
// TAG VOCABULARY: restaurant `cuisine_tags` come from two disagreeing sources —
// the gateway's Prisma seed writes HYPHENATED, often hyper-specific tags
// (`hakata-ramen`, `west-african`, `northern-italian`), while the AI service's
// `backend/ai_service/app/ai/taxonomy.py` speaks UNDERSCORED group/member/style
// keys (`middle_eastern`, `fine_dining`). `normalizeCuisineTag` collapses both to
// one lookup form, and TAG_TO_IMAGE_KEY below rolls every known tag from EITHER
// vocabulary up onto one of the pools. An unmapped tag is not an error — it just
// doesn't contribute a pool, and a restaurant with no mapped tag falls back to
// `default`.

export const IMAGES_PER_CUISINE = 5

// The pools that actually exist on disk. Keys use the taxonomy's underscore form
// so the mapping to `taxonomy.py` stays obvious; `default` is the fallback pool
// (neutral restaurant/table shots) and is never itself a cuisine.
export const CUISINE_IMAGE_KEYS = [
  'african',
  'american',
  'asian',
  'bakery',
  'bbq',
  'brazilian',
  'brunch',
  'burgers',
  'cafe',
  'cajun',
  'caribbean',
  'chinese',
  'dessert',
  'ethiopian',
  'european',
  'filipino',
  'fine_dining',
  'french',
  'greek',
  'indian',
  'indonesian',
  'italian',
  'japanese',
  'korean',
  'latin_american',
  'lebanese',
  'mediterranean',
  'mexican',
  'middle_eastern',
  'moroccan',
  'nepali',
  'peruvian',
  'pizza',
  'pub_bar',
  'ramen',
  'sandwich',
  'seafood',
  'southern',
  'spanish',
  'steakhouse',
  'sushi',
  'taiwanese',
  'thai',
  'turkish',
  'vegetarian',
  'vietnamese',
  'default',
] as const

export type CuisineImageKey = (typeof CUISINE_IMAGE_KEYS)[number]

export const FALLBACK_IMAGE_KEY: CuisineImageKey = 'default'

// Mirror of `taxonomy.normalize_tag`: lowercase, and collapse hyphens/spaces to a
// single underscore. That folds the seed's `middle-eastern` and the taxonomy's
// `middle_eastern` (and a stray "Middle Eastern") onto one lookup key.
export function normalizeCuisineTag(tag: string): string {
  return String(tag).trim().toLowerCase().replace(/[\s-]+/g, '_')
}

// Every cuisine tag we know how to illustrate → its pool.
//
// Three groups of entries, in order:
//   1. keys that ARE pools (identity) — kept explicit so a rename can't silently
//      drop a mapping;
//   2. `taxonomy.py` group members / style aliases that have no pool of their own;
//   3. the live seed catalog's hyper-specific regional tags (`oaxacan`,
//      `hakata-ramen`, `northern-chinese`, …) rolled up to their parent cuisine.
// Sub-regional tags roll up rather than getting their own pool because the
// difference is invisible in a 112px card banner.
const TAG_TO_IMAGE_KEY: Record<string, CuisineImageKey> = {
  // --- 1. identity: a pool named after the tag ---------------------------------
  african: 'african',
  american: 'american',
  asian: 'asian',
  bakery: 'bakery',
  bbq: 'bbq',
  brazilian: 'brazilian',
  brunch: 'brunch',
  burgers: 'burgers',
  cafe: 'cafe',
  cajun: 'cajun',
  caribbean: 'caribbean',
  chinese: 'chinese',
  dessert: 'dessert',
  ethiopian: 'ethiopian',
  european: 'european',
  filipino: 'filipino',
  fine_dining: 'fine_dining',
  french: 'french',
  greek: 'greek',
  indian: 'indian',
  indonesian: 'indonesian',
  italian: 'italian',
  japanese: 'japanese',
  korean: 'korean',
  latin_american: 'latin_american',
  lebanese: 'lebanese',
  mediterranean: 'mediterranean',
  mexican: 'mexican',
  middle_eastern: 'middle_eastern',
  moroccan: 'moroccan',
  nepali: 'nepali',
  peruvian: 'peruvian',
  pizza: 'pizza',
  pub_bar: 'pub_bar',
  ramen: 'ramen',
  sandwich: 'sandwich',
  seafood: 'seafood',
  southern: 'southern',
  spanish: 'spanish',
  steakhouse: 'steakhouse',
  sushi: 'sushi',
  taiwanese: 'taiwanese',
  thai: 'thai',
  turkish: 'turkish',
  vegetarian: 'vegetarian',
  vietnamese: 'vietnamese',

  // --- 2. taxonomy.py groups, members and style aliases ------------------------
  // Cuisine-group umbrellas (`seed_umbrella` + synonyms that reach tags).
  latin: 'latin_american',

  // asian members without a pool of their own.
  malaysian: 'asian',
  mongolian: 'asian',
  singaporean: 'asian',
  tibetan: 'nepali',
  sri_lankan: 'indian',
  cantonese: 'chinese',
  dim_sum: 'chinese',
  noodles: 'asian',

  // european members.
  german: 'european',
  portuguese: 'european',
  british: 'european',
  irish: 'pub_bar',
  polish: 'european',
  russian: 'european',
  swiss: 'european',
  scandinavian: 'european',
  hungarian: 'european',
  bistro: 'french',
  pasta: 'italian',

  // latin american members.
  argentinian: 'latin_american',
  colombian: 'latin_american',
  chilean: 'latin_american',
  cuban: 'caribbean',
  tex_mex: 'mexican',
  tacos: 'mexican',

  // middle eastern members.
  persian: 'middle_eastern',
  israeli: 'middle_eastern',
  syrian: 'middle_eastern',
  iraqi: 'middle_eastern',
  yemeni: 'middle_eastern',

  // african members.
  nigerian: 'african',
  south_african: 'african',
  senegalese: 'african',
  kenyan: 'african',
  ghanaian: 'african',

  // american members.
  soul_food: 'southern',
  new_american: 'american',
  classic_american: 'american',
  diner: 'brunch',
  hawaiian: 'american',

  // restaurant styles + their seed aliases (RESTAURANT_STYLES in taxonomy.py).
  barbecue: 'bbq',
  grill: 'bbq',
  fast_food: 'burgers',
  fast_casual: 'burgers',
  raw_bar: 'seafood',
  kaiseki: 'fine_dining',
  coffee: 'cafe',
  buffet: 'default',
  food_truck: 'default',
  street_food: 'default',
  vegetarian_vegan: 'vegetarian',
  vegan: 'vegetarian',
  ice_cream: 'dessert',
  breakfast: 'brunch',
  sandwich_deli: 'sandwich',
  sandwiches: 'sandwich',
  deli: 'sandwich',
  bar: 'pub_bar',
  gastropub: 'pub_bar',

  // --- 3. the live seed catalog's regional tags --------------------------------
  // gateway/prisma/seed.mjs pairs a broad tag with a hyper-specific one
  // (['japanese', 'hakata-ramen']); both are mapped so either position resolves.
  aegean_greek: 'greek',
  afghan: 'middle_eastern',
  argentine: 'latin_american',
  baja: 'mexican',
  bangkok_thai: 'thai',
  basque: 'spanish',
  belgian: 'european',
  burmese: 'asian',
  californian: 'american',
  chicago_style: 'pizza',
  creole: 'cajun',
  edomae_sushi: 'sushi',
  georgian: 'european',
  hakata_ramen: 'ramen',
  isan_thai: 'thai',
  izakaya: 'japanese',
  jamaican: 'caribbean',
  levantine: 'middle_eastern',
  neapolitan: 'pizza',
  nikkei: 'peruvian',
  north_african: 'moroccan',
  north_indian: 'indian',
  northern_chinese: 'chinese',
  northern_italian: 'italian',
  oaxacan: 'mexican',
  pakistani: 'indian',
  palestinian: 'middle_eastern',
  provencal: 'french',
  puerto_rican: 'caribbean',
  punjabi: 'indian',
  robata: 'japanese',
  roman: 'italian',
  salvadoran: 'latin_american',
  shan: 'asian',
  shanghainese: 'chinese',
  sichuan: 'chinese',
  south_indian: 'indian',
  tokyo_ramen: 'ramen',
  tuscan: 'italian',
  venezuelan: 'latin_american',
  west_african: 'african',
}

// Resolve a tag list to the DISTINCT pools it should draw from, in tag order.
// Distinct matters for the multi-tag rule below: ['chinese', 'cantonese'] both
// roll up to `chinese`, and must not weight that pool twice.
export function imageKeysForTags(cuisineTags: readonly string[] | null | undefined): CuisineImageKey[] {
  const keys: CuisineImageKey[] = []
  for (const tag of cuisineTags ?? []) {
    if (!tag) continue
    const key = TAG_TO_IMAGE_KEY[normalizeCuisineTag(tag)]
    if (key && !keys.includes(key)) keys.push(key)
  }
  return keys
}

// Public URL of one photo. `import.meta.env.BASE_URL` (always trailing-slashed)
// keeps this correct if the SPA is ever served from a sub-path rather than the
// domain root — a plain '/media/...' literal would 404 there.
export function cuisineImageUrl(key: CuisineImageKey, index: number): string {
  const n = (((index % IMAGES_PER_CUISINE) + IMAGES_PER_CUISINE) % IMAGES_PER_CUISINE) + 1
  return `${import.meta.env.BASE_URL}media/cuisines/${key}/${key}-${n}.jpg`
}

// Every photo a restaurant could show: the union of its cuisines' pools. This is
// what makes the multi-cuisine rule fall out for free — a place tagged
// ['italian', 'pizza'] draws from all 10 photos, so the pick is "randomly between
// those groups" AND randomly within the chosen group in one step.
export function cuisineImagePool(cuisineTags: readonly string[] | null | undefined): string[] {
  const keys = imageKeysForTags(cuisineTags)
  const pool = keys.length > 0 ? keys : [FALLBACK_IMAGE_KEY]
  return pool.flatMap((key) =>
    Array.from({ length: IMAGES_PER_CUISINE }, (_, i) => cuisineImageUrl(key, i)),
  )
}

// One random photo for a restaurant. Deliberately NOT deterministic and never
// persisted (see the header): each preview re-rolls. Callers should hold the
// result for the life of a mount — `useCuisineImage` does that — so a re-render
// (a vote landing, a hover) can't swap the picture mid-view.
export function randomCuisineImage(cuisineTags: readonly string[] | null | undefined): string {
  const pool = cuisineImagePool(cuisineTags)
  return pool[Math.floor(Math.random() * pool.length)]
}

// The neutral fallback used when an <img> fails to load (a missing/corrupt file
// should degrade to another photo, not a broken-image glyph).
export function fallbackCuisineImage(): string {
  return cuisineImageUrl(FALLBACK_IMAGE_KEY, Math.floor(Math.random() * IMAGES_PER_CUISINE))
}
