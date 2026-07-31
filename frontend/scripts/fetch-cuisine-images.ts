/**
 * One-off asset builder: populate `public/media/cuisines/` with the stock photos
 * the restaurant banners draw from.
 *
 *   bun run frontend/scripts/fetch-cuisine-images.ts             # fill in what's missing
 *   bun run frontend/scripts/fetch-cuisine-images.ts --force     # re-fetch everything
 *   bun run frontend/scripts/fetch-cuisine-images.ts thai sushi  # only these pools
 *   bun run frontend/scripts/fetch-cuisine-images.ts --reject thai/thai-2.jpg …
 *   bun run frontend/scripts/fetch-cuisine-images.ts --drop  thai/thai-4.jpg …
 *   bun run frontend/scripts/fetch-cuisine-images.ts --dedupe    # free repeated slots
 *   bun run frontend/scripts/fetch-cuisine-images.ts --borrow ethiopian french
 *   bun run frontend/scripts/fetch-cuisine-images.ts --check      # verify, fetch nothing
 *
 * `--reject` is how the set gets good. Search relevance alone cannot tell a plate
 * of pad thai from a photo of a Thai restaurant's front door, so the shipped set
 * is the one a REVIEWER kept: `--reject` deletes the named files, records their
 * Openverse ids in `rejected.json` so no later run can pick them again, and a
 * plain re-run refills the freed slots from fresh candidates. Repeat until a
 * review round finds nothing.
 *
 * `--drop` is the same delete-and-refill without the ban, for a photo that is
 * fine but REPEATED — the same id landing in two slots of one pool. `--dedupe`
 * finds those automatically (by id, and by near-identical title) and drops all
 * but the first.
 *
 * `--borrow` fills a pool's empty slots from its PARENT cuisine's searches only
 * (see PARENT_POOL). Reach for it when a pool has failed review repeatedly: a few
 * cuisines have hits that pass every metadata test and still are not food — a
 * jazz band at a restaurant called "Doro Wat", a theme-park ride named after
 * Ratatouille — and those resurface on every ordinary refill.
 *
 * `--check` guards the invariant that rots: an unmapped cuisine tag silently
 * falls through to the `default` pool, so it re-reads the gateway seed and the AI
 * taxonomy and names any tag `TAG_TO_IMAGE_KEY` hasn't been taught. Run it after
 * touching either vocabulary.
 *
 * The output is COMMITTED to the repo (Vite copies `public/` into `dist/`, so the
 * Render static site serves it) — this script exists to regenerate or extend the
 * set, not to run at build time. It is idempotent: a pool that already has its
 * full complement of files is skipped unless --force.
 *
 * SOURCE + LICENSING. Photos come from the Openverse API (openverse.org), the
 * CC-search index over Flickr / Wikimedia / museum collections. It needs no API
 * key, and — the reason it was chosen over an unsplash/pexels scrape — every hit
 * carries machine-readable provenance. The query is restricted to `cc0,pdm,by`,
 * i.e. public domain and plain CC BY: no ShareAlike (which would put terms on the
 * app around it), no NonCommercial, no NoDerivatives (resizing is a derivative).
 * CC BY still requires credit, so every downloaded file is recorded in
 * `credits.json` + `ATTRIBUTION.md` beside the images, keyed by filename.
 *
 * The pool KEYS are imported from `src/constants/cuisineImages.ts` rather than
 * re-listed here, so the files on disk and the runtime mapping cannot drift; this
 * script only owns the search queries that fill each pool.
 *
 * Resizing uses macOS `sips` (no image dependency in a Bun project for a script
 * that runs once). Without it the originals are written through unresized — the
 * pool still works, it's just heavier, and the script says so.
 */

import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CUISINE_IMAGE_KEYS,
  IMAGES_PER_CUISINE,
  imageKeysForTags,
  type CuisineImageKey,
} from '../src/constants/cuisineImages.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MEDIA_DIR = path.resolve(HERE, '../public/media/cuisines')

// Longest edge, in px. The largest on-screen use is the Events detail hero
// (~900px on a wide desktop) and the smallest a 112px card banner, so 800 covers
// every card at 2x and the hero at 1x.
const MAX_EDGE = 800
// 50 keeps a busy food photo around 60 KB. The whole set is committed, so the
// repo pays for this once per file — quality above ~60 buys nothing visible in a
// banner and adds several MB across ~235 images.
const JPEG_QUALITY = 50
// Anything under this after download is a placeholder/spacer, not a photo.
const MIN_BYTES = 12_000
// Guard against pulling a 20 MB museum scan through `sips`.
const MAX_BYTES = 12_000_000
// A very detailed photo can still land well over 100 KB at MAX_EDGE/QUALITY.
// Above this it gets one more pass at a lower quality — with ~235 committed
// files, a handful of 700 KB outliers is most of a megabyte for nothing.
const SOFT_MAX_BYTES = 140_000
const RETRY_QUALITY = 32

// Search terms per pool. Several per key on purpose: the results are interleaved
// round-robin so a pool of 5 shows five different DISHES, not five photographs of
// the same plate of noodles. Terms name the food rather than the country wherever
// possible — "pad thai" returns food, "thailand" returns beaches.
const QUERIES: Record<CuisineImageKey, string[]> = {
  // African / Brazilian / Ethiopian searches return far fewer permissively
  // licensed photos than the rest, so these carry extra DISH-level terms — the
  // named dish is what finds a photo where the country name finds a landscape.
  african: [
    'jollof rice',
    'nigerian food plate',
    'west african food',
    'suya skewers',
    'fufu and soup',
    'african stew dish',
  ],
  american: ['american diner food', 'mac and cheese dish', 'meatloaf plate', 'american comfort food'],
  asian: ['asian noodles bowl', 'asian street food', 'dumplings steamer', 'stir fry vegetables wok'],
  bakery: ['bakery bread display', 'croissant pastry', 'artisan bread loaves', 'pastry counter'],
  bbq: ['barbecue ribs', 'smoked brisket', 'bbq platter meat', 'pulled pork barbecue'],
  brazilian: [
    'feijoada',
    'churrasco grilled meat',
    'pao de queijo',
    'moqueca fish stew',
    'picanha steak',
    'brazilian rice and beans plate',
    'coxinha',
    'brazilian food dish',
  ],
  brunch: ['pancakes breakfast plate', 'eggs benedict brunch', 'avocado toast', 'breakfast eggs bacon'],
  burgers: ['cheeseburger', 'hamburger and fries', 'gourmet burger', 'burger plate'],
  cafe: ['latte art coffee', 'coffee shop interior', 'espresso cup saucer', 'cafe table coffee pastry'],
  cajun: ['gumbo bowl', 'jambalaya', 'crawfish boil', 'creole cajun food'],
  caribbean: ['jerk chicken', 'plantains rice and beans', 'caribbean food plate', 'cuban sandwich'],
  chinese: ['chinese food dish', 'dim sum dumplings', 'chinese noodles bowl', 'peking duck'],
  dessert: ['chocolate cake slice', 'ice cream dessert', 'dessert plate restaurant', 'tiramisu dessert'],
  ethiopian: [
    'injera',
    'doro wat',
    'ethiopian platter',
    'shiro wat',
    'ethiopian tibs',
    'kitfo',
    'ethiopian vegetarian combination',
    'ethiopian cuisine',
  ],
  european: ['schnitzel plate', 'european food dish', 'belgian fries', 'goulash bowl'],
  filipino: ['chicken adobo filipino', 'lechon', 'pancit', 'sinigang', 'sisig', 'kare kare filipino', 'filipino food'],
  fine_dining: ['fine dining plated dish', 'gourmet plating restaurant', 'tasting menu course', 'plated haute cuisine'],
  french: ['french cuisine dish', 'coq au vin', 'ratatouille', 'french bistro food'],
  greek: ['greek salad', 'gyro souvlaki', 'greek meze plate', 'moussaka'],
  indian: ['indian curry dish', 'indian thali', 'biryani', 'naan and curry'],
  indonesian: ['nasi goreng', 'satay skewers', 'rendang', 'indonesian food'],
  italian: ['pasta dish italian', 'risotto', 'spaghetti bolognese', 'italian food plate'],
  japanese: ['japanese food plate', 'bento box', 'tempura', 'okonomiyaki'],
  korean: ['korean bbq grill', 'bibimbap', 'kimchi banchan', 'korean food'],
  latin_american: ['arepas', 'empanadas', 'ceviche', 'latin american food'],
  lebanese: ['hummus and falafel', 'lebanese mezze', 'shawarma plate', 'tabbouleh'],
  mediterranean: ['mezze platter', 'mediterranean food plate', 'grilled octopus', 'olives bread olive oil'],
  mexican: ['tacos', 'enchiladas', 'guacamole', 'mexican food plate'],
  middle_eastern: ['kebab platter', 'falafel plate', 'shawarma', 'middle eastern food'],
  moroccan: ['tagine moroccan', 'couscous dish', 'moroccan food', 'moroccan mint tea'],
  nepali: ['momo dumplings nepali', 'dal bhat', 'nepali food', 'himalayan food'],
  peruvian: ['ceviche peruvian', 'lomo saltado', 'peruvian food', 'anticuchos'],
  pizza: ['pizza margherita', 'neapolitan pizza', 'pizza slice', 'wood fired pizza'],
  pub_bar: ['pub interior beer', 'beer glass bar', 'bar counter drinks', 'gastropub food'],
  ramen: ['ramen bowl', 'tonkotsu ramen', 'japanese ramen noodles', 'ramen shop'],
  sandwich: ['deli sandwich', 'submarine sandwich', 'club sandwich plate', 'grilled cheese sandwich'],
  seafood: ['seafood platter', 'grilled fish plate', 'oysters on ice', 'shrimp dish'],
  southern: ['fried chicken plate', 'biscuits and gravy', 'collard greens cornbread', 'southern comfort food'],
  spanish: ['spanish tapas', 'paella', 'jamon iberico', 'patatas bravas'],
  steakhouse: ['grilled steak plate', 'ribeye steak', 'steak dinner', 'porterhouse steak'],
  sushi: ['sushi platter', 'nigiri sushi', 'sushi rolls', 'sashimi plate'],
  taiwanese: ['beef noodle soup taiwan', 'taiwanese street food', 'bubble tea', 'xiao long bao'],
  thai: ['pad thai', 'thai green curry', 'tom yum soup', 'thai food plate'],
  turkish: ['turkish kebab', 'turkish breakfast', 'baklava plate', 'lahmacun', 'iskender kebab', 'turkish pide', 'turkish food'],
  vegetarian: ['vegan buddha bowl', 'vegetarian salad plate', 'plant based meal', 'roasted vegetables dish'],
  vietnamese: ['pho vietnamese', 'banh mi', 'vietnamese spring rolls', 'vietnamese food'],
  default: ['restaurant table food', 'restaurant interior dining', 'plated meal restaurant', 'dinner table spread'],
}

interface OpenverseHit {
  id: string
  title: string
  url: string
  creator: string | null
  creator_url: string | null
  license: string
  license_version: string | null
  license_url: string | null
  source: string
  foreign_landing_url: string
  width: number | null
  height: number | null
}

interface Credit {
  key: CuisineImageKey
  file: string
  openverse_id: string
  title: string
  creator: string
  creator_url: string | null
  license: string
  license_url: string | null
  source: string
  source_page: string
  original_url: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Openverse returns a bare licence slug. Most are CC variants that read correctly
// as "CC <SLUG>", but the two public-domain ones are not CC licences at all — the
// naive prefix produces "CC CC0" and "CC PDM".
const LICENSE_LABEL: Record<string, string> = { cc0: 'CC0', pdm: 'Public Domain Mark' }

function licenseLabel(hit: OpenverseHit): string {
  const base = LICENSE_LABEL[hit.license] ?? `CC ${hit.license.toUpperCase()}`
  return hit.license_version ? `${base} ${hit.license_version}` : base
}

// Openverse providers that are CURATED stock libraries rather than open photo
// dumps. Their hit rate for a usable banner is far higher than Flickr's, which is
// mostly phone snapshots of half-eaten dinners — so they are searched first and
// their results sit at the front of every candidate list. They have no coverage
// at all for narrower cuisines ("jollof rice" returns 0), hence the fallback.
const CURATED_SOURCES = 'stocksnap,rawpixel,nappy'

// Openverse providers that can never supply a restaurant banner. iNaturalist is a
// species-observation database: a search for a cuisine whose dishes are named
// after fish returns a specimen held in someone's hand, and its titles are Latin
// name-lists that happen to contain the country, so neither the vocabulary check
// nor the blocklist catches it.
const EXCLUDED_PROVIDERS = new Set(['inaturalist'])

// The search passes, most-selective first. Every pass keeps the LICENCE filter —
// that one is a correctness constraint, not a preference — and results are
// concatenated in this order, so a curated landscape photograph always outranks a
// relaxed Flickr hit for the same query.
//   relax 0 — landscape JPEG photographs
//   relax 1 — any orientation (the metadata ratio check still rejects portraits)
//   relax 2 — any file type, any Openverse category
const PASSES: { source: string | null; relax: 0 | 1 | 2; page: number }[] = [
  { source: CURATED_SOURCES, relax: 0, page: 1 },
  { source: CURATED_SOURCES, relax: 1, page: 1 },
  { source: null, relax: 0, page: 1 },
  { source: null, relax: 0, page: 2 },
  { source: null, relax: 1, page: 1 },
  { source: null, relax: 2, page: 1 },
]

/** One Openverse search page, filtered to reusable-with-credit photographs. */
async function search(
  query: string,
  { source, relax, page }: { source: string | null; relax: 0 | 1 | 2; page: number },
): Promise<OpenverseHit[]> {
  const params = new URLSearchParams({
    q: query,
    page: String(page),
    page_size: '20',
    // Public domain + plain attribution only — see the licensing note up top.
    license: 'cc0,pdm,by',
    mature: 'false',
  })
  if (source) params.set('source', source)
  if (relax < 2) {
    params.set('extension', 'jpg')
    params.set('category', 'photograph')
  }
  // Landscape crops survive a 16:9-ish banner far better; dropped on the retry
  // passes because narrow queries come back nearly empty with it applied.
  if (relax < 1) params.set('aspect_ratio', 'wide')

  // A failed search is ONE thin query, never a reason to abandon the run: a single
  // Openverse timeout ~40 pools into a fill used to take the whole thing down and
  // leave the remaining pools empty. Degrade to no results and carry on.
  try {
    const res = await fetch(`https://api.openverse.org/v1/images/?${params}`, {
      headers: { 'User-Agent': 'GrubGroup-asset-builder/1.0 (capstone project)' },
      signal: AbortSignal.timeout(30_000),
    })
    // A page past the end is a 404, not an error worth reporting.
    if (res.status === 404) return []
    if (!res.ok) {
      console.warn(`  ! search "${query}" -> HTTP ${res.status}`)
      return []
    }
    const body = (await res.json()) as { results?: OpenverseHit[] }
    return body.results ?? []
  } catch (err) {
    console.warn(`  ! search "${query}" failed: ${(err as Error).name}`)
    return []
  }
}

// Every on-screen frame is landscape (a 112px card banner, a 224px hero, a square
// thumbnail), so a portrait shot loses most of its subject to `object-cover`. The
// API's own `aspect_ratio=wide` is dropped on the relaxed passes, so re-check it
// here against the reported dimensions — that is what keeps a 329x800 photo of a
// Korean table out of the set.
function isLandscape(hit: OpenverseHit): boolean {
  if (!hit.width || !hit.height) return true // unknown — let the download decide
  return hit.width >= hit.height * 1.15
}

// ---------------------------------------------------------------------------
// Relevance. A full-text search for a cuisine returns plenty that is ABOUT the
// cuisine without being a photo of its food: a postage stamp depicting Korean
// food, a banknote filed under "mediterranean", a restaurant's shopfront, a
// festival crowd. Openverse has no "is this a plate of food" signal, so the
// title is the filter: it must look like a dish, and must not look like one of
// the recurring non-food subjects.
// ---------------------------------------------------------------------------

// Words too generic to prove a hit belongs to a PARTICULAR pool — nearly every
// candidate's title has one, so they are stripped from the per-pool vocabulary
// (they stay usable via `EXTRA_TERMS` where a pool genuinely needs them).
const GENERIC_TERMS = new Set([
  'a', 'an', 'and', 'at', 'de', 'for', 'in', 'la', 'of', 'on', 'the', 'with',
  'bowl', 'cuisine', 'dish', 'food', 'meal', 'plate', 'platter', 'restaurant',
  'free', 'image', 'photo', 'style', 'shop', 'top',
])

// Subjects that keep surfacing and are never what a restaurant banner wants.
// Matched as substrings of the lowercased title, so "postage stamp" and
// "stamp collection" both go.
const BLOCKED_TITLE_TERMS = [
  'stamp', 'postage', 'banknote', 'bank note', 'coin', 'currency', 'money',
  'wilt', 'disease', 'pest', 'fungus', 'virus',
  'logo', 'signage', 'poster', 'billboard', 'advert', 'brochure', 'menu at',
  'map of', 'portrait', 'president', 'minister', 'parade', 'protest',
  'cemetery', 'church', 'cathedral', 'museum', 'stadium', 'casino',
  'soldier', 'military', 'headquarters', 'army', 'navy', 'troops',
  'storefront', 'shopfront', 'facade', 'exterior', 'architecture', 'ruins',
  'hotel', 'motel', 'inn,', 'festival', 'parking', 'salt block', 'salt lamp',
  'chips', 'packet', 'packaging', 'wrapper', 'supermarket', 'grocery',
  // Added after review rounds kept surfacing these: an event, a performance or a
  // workplace photographed AT a restaurant is still not a photo of its food.
  'laborator', 'fellows', 'conference', 'seminar', 'workshop', 'ceremony',
  'band', 'music club', 'jazz', 'concert', 'stage', 'carnival', 'samba',
  'ride', 'theme park', 'gymnasium', 'microscope', 'scientist',
]

// Words that indicate the frame contains FOOD or a meal.
//
// The per-pool vocabulary answers "which cuisine is this about?", which is not
// the same question as "is this a plate of food?" — "IAEA Fellows Latin America"
// passes a Latin American vocabulary check with flying colours and is a photo of
// a laboratory. A title must clear BOTH tests: it must name this pool's cuisine
// AND look like it is describing something edible.
//
// Built from every dish name the script searches for (across all pools, since a
// dish name is proof of food regardless of which pool it belongs to) plus the
// generic meal words that were stripped from the pool vocabularies for being too
// unspecific — exactly the words that are useless for telling pools apart and
// perfect for telling food from not-food.
const GENERIC_FOOD_WORDS = [
  'food', 'dish', 'plate', 'platter', 'bowl', 'meal', 'lunch', 'dinner', 'supper',
  'breakfast', 'brunch', 'snack', 'appetizer', 'appetiser', 'starter', 'entree',
  'dessert', 'soup', 'stew', 'salad', 'sandwich', 'rice', 'noodle', 'bread',
  'grill', 'roast', 'fried', 'baked', 'braised', 'steamed', 'smoked', 'sauce',
  'curry', 'cheese', 'chicken', 'beef', 'pork', 'lamb', 'fish', 'shrimp', 'veg',
  'cuisine', 'menu', 'recipe', 'cook', 'kitchen', 'eat', 'tasting', 'coffee',
  'tea', 'beer', 'wine', 'cocktail', 'cafe', 'bistro', 'restaurant', 'buffet',
]

let _foodWords: string[] | null = null

/** Every dish name across every pool, plus the generic meal words. */
function foodWords(): string[] {
  if (_foodWords) return _foodWords
  const words = new Set(GENERIC_FOOD_WORDS)
  for (const key of CUISINE_IMAGE_KEYS) {
    for (const phrase of QUERIES[key]) {
      for (const word of phrase.toLowerCase().split(/[^a-z]+/)) {
        if (word.length > 2) words.add(word)
      }
    }
    for (const term of EXTRA_TERMS[key] ?? []) words.add(term.toLowerCase())
  }
  // The pool KEYS are cuisine names, not food — drop them so "latin america"
  // alone can't satisfy the food test.
  for (const key of CUISINE_IMAGE_KEYS) {
    for (const part of key.split('_')) words.delete(part)
  }
  _foodWords = [...words]
  return _foodWords
}

// A title that is really a camera filename or an agency slug ("DSC05823.jpg",
// "20241025-USDA-FNS-UNK-0013", "IMG_0871", "(untitled)") tells us nothing about
// what is in the frame, and those turned out to be wrong about as often as right.
const OPAQUE_TITLE = /^(\(?untitled\)?|(img|dsc|dscn|dscf|p|gz|ls|mg|pxl|photo)[\s_-]*\d+|[\d\s_-]{6,}|[a-z]{2,6}[\s_-]?\d{4,})/i

// Extra vocabulary for pools whose queries alone are too thin to recognise a good
// hit — mostly regional dish names and the demonyms a photographer actually types.
const EXTRA_TERMS: Partial<Record<CuisineImageKey, string[]>> = {
  african: ['ghana', 'nigeria', 'nigerian', 'senegal', 'kenyan', 'egusi', 'injera', 'plantain'],
  american: ['diner', 'burger', 'hotdog', 'hot dog', 'ribs', 'wings', 'cornbread', 'casserole'],
  asian: ['chinese', 'japanese', 'korean', 'thai', 'vietnamese', 'pho', 'ramen', 'bao', 'rice'],
  bakery: ['bread', 'baguette', 'sourdough', 'pastries', 'pastry', 'danish', 'scone', 'muffin'],
  brazilian: ['brasil', 'brasileira', 'picanha', 'acai', 'salgado', 'rice and beans'],
  brunch: ['omelette', 'omelet', 'waffles', 'french toast', 'bacon', 'granola', 'benedict'],
  cafe: ['cappuccino', 'americano', 'barista', 'flat white', 'coffee'],
  cajun: ['creole', 'etouffee', 'po boy', 'boudin', 'louisiana', 'shrimp', 'okra'],
  caribbean: ['jamaica', 'jamaican', 'cuba', 'cuban', 'trinidad', 'oxtail', 'roti', 'callaloo'],
  chinese: ['wonton', 'noodle', 'bao', 'szechuan', 'sichuan', 'chow', 'kung pao', 'hot pot'],
  default: ['food', 'restaurant', 'dish', 'plate', 'lunch', 'supper', 'bistro', 'brasserie'],
  ethiopian: ['ethiopia', 'eritrean', 'tibs', 'kitfo', 'wot', 'wat', 'injera'],
  european: ['german', 'austrian', 'czech', 'polish', 'dutch', 'sausage', 'sauerkraut', 'stew'],
  filipino: ['philippine', 'philippines', 'sinigang', 'sisig', 'kare kare', 'halo halo', 'longganisa'],
  fine_dining: ['degustation', 'amuse bouche', 'sous vide', 'chef', 'plating', 'course'],
  french: ['bourguignon', 'cassoulet', 'crepe', 'quiche', 'baguette', 'brie', 'confit', 'bistro'],
  greek: ['gyros', 'tzatziki', 'feta', 'dolma', 'spanakopita', 'saganaki'],
  indian: ['masala', 'tikka', 'dosa', 'samosa', 'paneer', 'dal', 'tandoori', 'chutney'],
  indonesian: ['indonesia', 'gado', 'bakso', 'tempeh', 'sambal', 'soto', 'nasi', 'mie'],
  italian: ['lasagna', 'lasagne', 'gnocchi', 'carbonara', 'pesto', 'ravioli', 'linguine', 'penne'],
  japanese: ['sushi', 'ramen', 'udon', 'donburi', 'katsu', 'miso', 'yakitori', 'sashimi'],
  korean: ['korea', 'bulgogi', 'japchae', 'tteokbokki', 'gochujang', 'banchan', 'galbi'],
  latin_american: ['colombian', 'venezuelan', 'argentin', 'chilean', 'pupusa', 'tamale', 'asado', 'chimichurri'],
  lebanese: ['lebanon', 'mezze', 'meze', 'kibbeh', 'manakish', 'labneh', 'baba ganoush'],
  mediterranean: ['greek', 'olive', 'feta', 'hummus', 'pita', 'grilled fish', 'calamari'],
  mexican: ['burrito', 'quesadilla', 'salsa', 'mole', 'tamale', 'elote', 'carnitas', 'birria'],
  middle_eastern: ['hummus', 'pita', 'tahini', 'baba', 'mansaf', 'persian', 'turkish', 'levantine'],
  moroccan: ['morocco', 'tajine', 'harira', 'pastilla', 'merguez', 'ras el hanout'],
  nepali: ['nepal', 'momo', 'thukpa', 'sel roti', 'tibetan', 'sherpa'],
  peruvian: ['peru', 'aji', 'causa', 'papa a la huancaina', 'chicharron', 'pisco'],
  pizza: ['pepperoni', 'calzone', 'pizzeria', 'mozzarella', 'focaccia'],
  pub_bar: ['pint', 'ale', 'lager', 'brewery', 'tavern', 'pub', 'cocktail', 'draught'],
  ramen: ['noodle', 'miso', 'shoyu', 'tonkotsu', 'chashu', 'broth'],
  sandwich: ['sub', 'hoagie', 'panini', 'bagel', 'reuben', 'baguette', 'wrap', 'toastie'],
  seafood: ['fish', 'salmon', 'lobster', 'crab', 'mussels', 'clams', 'scallops', 'ceviche', 'prawn'],
  southern: ['grits', 'gumbo', 'catfish', 'mac and cheese', 'okra', 'cobbler', 'barbecue'],
  spanish: ['tortilla espanola', 'gazpacho', 'chorizo', 'croquetas', 'pintxos', 'churros'],
  steakhouse: ['sirloin', 'filet', 'tenderloin', 't-bone', 'porterhouse', 'wagyu', 'prime rib'],
  sushi: ['maki', 'temaki', 'sashimi', 'nigiri', 'roll', 'omakase', 'wasabi'],
  taiwanese: ['taiwan', 'gua bao', 'lu rou fan', 'oyster omelette', 'boba', 'night market'],
  thai: ['thailand', 'massaman', 'panang', 'som tam', 'larb', 'satay', 'sticky rice'],
  turkish: ['turkey', 'doner', 'lahmacun', 'pide', 'meze', 'kofte', 'simit', 'borek'],
  vegetarian: ['vegan', 'vegetarian', 'tofu', 'tempeh', 'chickpea', 'lentil', 'quinoa', 'salad'],
  vietnamese: ['vietnam', 'pho', 'bun cha', 'goi cuon', 'com tam', 'nuoc cham', 'vermicelli'],
}

// Where a pool borrows from when its own searches can't fill it.
//
// The narrow cuisines run out of permissively-licensed FOOD photos long before
// they run out of search results, and the leftovers are shopfronts, neon signs
// and crowd shots. Widening the net used to mean dropping the relevance check —
// which is how a photo of a dog once landed in the American pool. Borrowing from
// the parent cuisine instead keeps every candidate on-topic: an African stew is a
// defensible banner for an Ethiopian restaurant; a lab technician is not.
const PARENT_POOL: Partial<Record<CuisineImageKey, CuisineImageKey>> = {
  brazilian: 'latin_american',
  peruvian: 'latin_american',
  caribbean: 'latin_american',
  ethiopian: 'african',
  moroccan: 'african',
  nepali: 'indian',
  filipino: 'asian',
  indonesian: 'asian',
  taiwanese: 'chinese',
  chinese: 'asian',
  japanese: 'asian',
  korean: 'asian',
  thai: 'asian',
  vietnamese: 'asian',
  indian: 'asian',
  mexican: 'latin_american',
  ramen: 'japanese',
  sushi: 'japanese',
  lebanese: 'middle_eastern',
  turkish: 'middle_eastern',
  greek: 'mediterranean',
  mediterranean: 'greek',
  french: 'european',
  spanish: 'european',
  italian: 'european',
  southern: 'american',
  cajun: 'american',
  sandwich: 'american',
  fine_dining: 'european',
  latin_american: 'mexican',
  middle_eastern: 'lebanese',
  african: 'ethiopian',
  asian: 'chinese',
  european: 'italian',
  american: 'burgers',
}

// The words that prove a hit belongs to THIS pool: everything meaningful from its
// search terms, plus the pool key itself, plus any hand-added vocabulary.
function vocabularyFor(key: CuisineImageKey): string[] {
  const words = new Set<string>()
  for (const phrase of [...QUERIES[key], key.replace(/_/g, ' ')]) {
    for (const word of phrase.toLowerCase().split(/[^a-z]+/)) {
      if (word.length > 2 && !GENERIC_TERMS.has(word)) words.add(word)
    }
  }
  for (const term of EXTRA_TERMS[key] ?? []) words.add(term.toLowerCase())
  return [...words]
}

/** Reject a title that is opaque, off-subject, not food, or not this pool's. */
function isRelevant(hit: OpenverseHit, vocabulary: string[], requireVocabulary: boolean): boolean {
  const title = (hit.title ?? '').toLowerCase()
  if (!title || OPAQUE_TITLE.test(title.trim())) return false
  if (BLOCKED_TITLE_TERMS.some((term) => title.includes(term))) return false
  // Must read as food. Checked even on a relaxed pass — "is this edible" is never
  // the requirement worth dropping.
  if (!foodWords().some((term) => title.includes(term))) return false
  if (!requireVocabulary) return true
  return vocabulary.some((term) => title.includes(term))
}

/** Word-set key for near-duplicate detection ("Ceviche (Peruvian Food)" twice). */
function titleWords(hit: OpenverseHit): Set<string> {
  return wordsOf(hit.title ?? '')
}

function wordsOf(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((w) => w.length > 2 && !GENERIC_TERMS.has(w)),
  )
}

function tooSimilar(words: Set<string>, taken: Set<string>[]): boolean {
  if (words.size === 0) return false
  return taken.some((prior) => {
    if (prior.size === 0) return false
    let shared = 0
    for (const w of words) if (prior.has(w)) shared++
    // Jaccard over the smaller set: "Ceviche Peruvian" vs "Ceviche Peruvian Food"
    // is a re-upload of the same shoot far more often than it is two dishes.
    return shared / Math.min(words.size, prior.size) >= 0.6
  })
}

/**
 * Candidates for one pool, best-first.
 *
 * Results are interleaved round-robin across the pool's queries so the five files
 * that survive come from five different searches where possible, then filtered
 * for landscape framing, subject relevance, and variety (one photographer, one
 * distinct dish per pool).
 *
 * The vocabulary requirement is dropped on a second pass IF the strict one can't
 * fill the pool — a thin cuisine is better served by a loosely-matched food photo
 * than by an empty slot. The blocklist and the de-duplication are NOT relaxed:
 * those reject things that are wrong, not merely unproven.
 */
async function candidatesFor(
  key: CuisineImageKey,
  banned: Set<string>,
  inPool: { ids: Set<string>; creators: Set<string>; titles: Set<string>[] },
  need: number,
  { borrowOnly = false }: { borrowOnly?: boolean } = {},
): Promise<OpenverseHit[]> {
  // `--borrow` skips this pool's own searches entirely. Some cuisines have a
  // handful of hits that pass every metadata test and are still not photographs
  // of food — a jazz band at a restaurant called "Doro Wat", a theme-park ride
  // named after Ratatouille, a menu board reading "CUBAN SANDWICH $4.00". Titles
  // cannot separate those from the real thing, and they resurface every refill.
  // Going straight to the parent cuisine is how those slots get filled at all.
  if (borrowOnly) {
    const parent = PARENT_POOL[key]
    if (!parent) {
      console.warn(`  ! ${key}: --borrow requested but no parent pool is defined`)
      return []
    }
    const hits = await onVocabularyHits(parent, key, banned, inPool)
    console.log(`  · ${key}: ${hits.length} borrowed from ${parent} (own searches skipped)`)
    return hits
  }

  const strict = await onVocabularyHits(key, key, banned, inPool)
  if (strict.length >= need) return strict

  // Not enough on-topic candidates of this pool's own — borrow from the parent
  // cuisine (still vocabulary-checked against the PARENT, so the borrowed photos
  // are on-theme rather than merely un-rejected).
  const parent = PARENT_POOL[key]
  if (!parent) {
    console.log(`  · ${key}: only ${strict.length} on-vocabulary candidate(s), no parent pool`)
    return strict
  }
  const seen = new Set(strict.map((h) => h.id))
  const borrowed = (await onVocabularyHits(parent, key, banned, inPool)).filter(
    (h) => !seen.has(h.id),
  )
  console.log(`  · ${key}: ${strict.length} own + ${borrowed.length} borrowed from ${parent}`)
  return [...strict, ...borrowed]
}

/**
 * Search `queryKey`'s terms and keep only hits whose title proves they belong to
 * it, then thin them for variety. `poolKey` is where the results are destined —
 * it only matters for the already-in-pool exclusions.
 */
async function onVocabularyHits(
  queryKey: CuisineImageKey,
  poolKey: CuisineImageKey,
  banned: Set<string>,
  inPool: { ids: Set<string>; creators: Set<string>; titles: Set<string>[] },
): Promise<OpenverseHit[]> {
  void poolKey
  const perQuery: OpenverseHit[][] = []
  for (const q of QUERIES[queryKey]) {
    const hits: OpenverseHit[] = []
    const seen = new Set<string>()
    for (const pass of PASSES) {
      // Stop escalating once there is plenty to choose from: a rich query never
      // needs the relaxed passes, and each one is a round trip.
      if (hits.length >= 12) break
      for (const hit of await search(q, pass)) {
        if (seen.has(hit.id) || banned.has(hit.id) || inPool.ids.has(hit.id)) continue
        if (EXCLUDED_PROVIDERS.has(hit.source) || !isLandscape(hit)) continue
        seen.add(hit.id)
        hits.push(hit)
      }
      await sleep(120) // be a good citizen against a keyless public API
    }
    perQuery.push(hits)
  }

  const vocabulary = vocabularyFor(queryKey)
  const pick = (requireVocabulary: boolean, exclude: Set<string>): OpenverseHit[] => {
    const seenId = new Set(exclude)
    // Seeded with what the pool ALREADY holds. Without this, topping up two freed
    // slots picks the best two candidates with no idea that the survivors next to
    // them are the same photographer's shot of the same plate — which is exactly
    // how one pool ended up with three copies of "Birthday Breakfast".
    const seenCreator = new Set(inPool.creators)
    const seenWords: Set<string>[] = [...inPool.titles]
    const out: OpenverseHit[] = []
    const depth = Math.max(0, ...perQuery.map((h) => h.length))
    for (let i = 0; i < depth; i++) {
      for (const hits of perQuery) {
        const hit = hits[i]
        if (!hit || seenId.has(hit.id)) continue
        if (!isRelevant(hit, vocabulary, requireVocabulary)) continue
        // One photo per photographer: a single Flickr food set is big enough to
        // supply a whole pool, and five frames of one lunch is not variety.
        // An UNKNOWN creator is not evidence of a shared one — the curated
        // providers leave the field null on most images, so treating them as one
        // photographer would cap those pools at a single stock photo.
        const creator = (hit.creator ?? '').trim().toLowerCase()
        if (creator && creator !== 'unknown' && seenCreator.has(creator)) continue
        const words = titleWords(hit)
        if (tooSimilar(words, seenWords)) continue
        seenId.add(hit.id)
        if (creator) seenCreator.add(creator)
        seenWords.push(words)
        out.push(hit)
      }
    }
    return out
  }

  // ON-VOCABULARY ONLY. There used to be a `pick(false, …)` top-up that dropped
  // the title check when the strict pass came up short, on the theory that a
  // loosely-matched food photo beats an empty slot. It does not: what the relaxed
  // pass actually returns, once the good hits for a query are exhausted, is
  // whatever else the search engine associated with the word — shopfronts, neon
  // signs, a lab bench, a dog in a picture frame. Coming up short and borrowing
  // from the parent cuisine is strictly better.
  return pick(true, new Set())
}

/** Download to `dest`, then resize/re-encode in place. Returns false on any reject. */
async function fetchImage(hit: OpenverseHit, dest: string): Promise<boolean> {
  let bytes: ArrayBuffer
  try {
    const res = await fetch(hit.url, {
      headers: { 'User-Agent': 'GrubGroup-asset-builder/1.0 (capstone project)' },
      signal: AbortSignal.timeout(45_000),
      redirect: 'follow',
    })
    if (!res.ok) return false
    const type = res.headers.get('content-type') ?? ''
    if (!type.startsWith('image/')) return false
    bytes = await res.arrayBuffer()
  } catch {
    return false
  }
  if (bytes.byteLength < MIN_BYTES || bytes.byteLength > MAX_BYTES) return false

  await Bun.write(dest, bytes)

  // `sips` rewrites in place via --out; a failure here means the bytes weren't a
  // decodable image, so treat it as a rejected candidate rather than shipping it.
  if (!(await encode(dest, JPEG_QUALITY))) {
    await rm(dest, { force: true })
    return false
  }
  if (Bun.file(dest).size > SOFT_MAX_BYTES) await encode(dest, RETRY_QUALITY)
  return true
}

/** Resize + re-encode `file` in place. False if `sips` couldn't decode it. */
async function encode(file: string, quality: number): Promise<boolean> {
  const proc = Bun.spawn(
    [
      'sips',
      '-s', 'format', 'jpeg',
      '-s', 'formatOptions', String(quality),
      '--resampleHeightWidthMax', String(MAX_EDGE),
      file,
      '--out', file,
    ],
    { stdout: 'ignore', stderr: 'ignore' },
  )
  return (await proc.exited) === 0
}

async function fillPool(
  key: CuisineImageKey,
  force: boolean,
  banned: Set<string>,
  borrowOnly = false,
): Promise<Credit[]> {
  const dir = path.join(MEDIA_DIR, key)
  await mkdir(dir, { recursive: true })

  if (force) {
    for (const f of await readdir(dir)) await rm(path.join(dir, f), { force: true })
  }

  const missing: number[] = []
  for (let n = 1; n <= IMAGES_PER_CUISINE; n++) {
    if (!existsSync(path.join(dir, `${key}-${n}.jpg`))) missing.push(n)
  }
  if (missing.length === 0) {
    console.log(`= ${key}: already complete`)
    return []
  }

  // What this pool already holds, so a top-up doesn't duplicate a survivor.
  const creditsPath = path.join(MEDIA_DIR, 'credits.json')
  const existing = existsSync(creditsPath)
    ? ((await Bun.file(creditsPath).json()) as Credit[]).filter((c) => c.key === key)
    : []
  const inPool = {
    ids: new Set(existing.map((c) => c.openverse_id)),
    creators: new Set(
      existing
        .map((c) => (c.creator ?? '').trim().toLowerCase())
        .filter((c) => c && c !== 'unknown'),
    ),
    titles: existing.map((c) => wordsOf(c.title)),
  }

  const pool = await candidatesFor(key, banned, inPool, missing.length, { borrowOnly })
  const credits: Credit[] = []
  let cursor = 0
  for (const n of missing) {
    let placed = false
    while (cursor < pool.length && !placed) {
      const hit = pool[cursor++]
      const file = `${key}-${n}.jpg`
      if (await fetchImage(hit, path.join(dir, file))) {
        credits.push({
          key,
          file: `${key}/${file}`,
          openverse_id: hit.id,
          title: hit.title || '(untitled)',
          creator: hit.creator || 'Unknown',
          creator_url: hit.creator_url,
          license: licenseLabel(hit),
          license_url: hit.license_url,
          source: hit.source,
          source_page: hit.foreign_landing_url,
          original_url: hit.url,
        })
        placed = true
      }
    }
    if (!placed) {
      console.warn(`  ! ${key}: ran out of candidates at slot ${n} (${pool.length} tried)`)
      break
    }
  }
  console.log(`+ ${key}: ${credits.length}/${missing.length} fetched`)
  return credits
}

async function writeCredits(credits: Credit[]): Promise<void> {
  // Merge with whatever is already recorded so an incremental run (one pool, or a
  // top-up of missing slots) doesn't drop the attribution for untouched files.
  const creditsPath = path.join(MEDIA_DIR, 'credits.json')
  const byFile = new Map<string, Credit>()
  if (existsSync(creditsPath)) {
    const prior = (await Bun.file(creditsPath).json()) as Credit[]
    for (const c of prior) byFile.set(c.file, c)
  }
  for (const c of credits) byFile.set(c.file, c)

  const all = [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file))
  await writeFile(creditsPath, `${JSON.stringify(all, null, 2)}\n`)

  const lines = [
    '# Image credits',
    '',
    'Every photo in this folder came from the [Openverse](https://openverse.org) index and is',
    'public domain or CC BY — reuse is allowed with credit, which this file provides. Photos',
    'were resized and re-encoded as JPEG by `frontend/scripts/fetch-cuisine-images.ts`;',
    '`credits.json` is the machine-readable version of the same list.',
    '',
    '**These are stock photos of food, not photographs of the restaurants they appear on.**',
    'They are picked at random per view purely as decoration (see',
    '`frontend/src/constants/cuisineImages.ts`).',
    '',
    'Every file here was reviewed by eye before it shipped. Photos that were searched up but',
    'turned out to be a shopfront, a sign, the wrong cuisine, or simply a bad banner were removed',
    'with `--reject`, which records their ids in `rejected.json` so a later run cannot pick them',
    'again. Do the same rather than deleting a file by hand.',
    '',
    '| File | Title | Creator | Licence | Source |',
    '| --- | --- | --- | --- | --- |',
    ...all.map((c) => {
      const title = c.title.replace(/\|/g, '\\|').slice(0, 60)
      const creator = c.creator_url ? `[${c.creator}](${c.creator_url})` : c.creator
      const licence = c.license_url ? `[${c.license}](${c.license_url})` : c.license
      return `| \`${c.file}\` | ${title} | ${creator} | ${licence} | [${c.source}](${c.source_page}) |`
    }),
    '',
  ]
  await writeFile(path.join(MEDIA_DIR, 'ATTRIBUTION.md'), lines.join('\n'))
}

// ---------------------------------------------------------------------------
// Rejection list. A search engine cannot tell a plate of pad thai from a photo of
// a Thai restaurant's front door, so the set that ships is the one a REVIEWER
// kept. `--reject` records that judgement permanently: the Openverse ids of
// rejected photos go in `rejected.json`, every later run skips them, and the
// freed slots refill from fresh candidates. Without it, a refill just downloads
// the same rejected photo back into the same slot.
// ---------------------------------------------------------------------------

const REJECTED_PATH = path.join(MEDIA_DIR, 'rejected.json')

async function loadBanned(): Promise<Set<string>> {
  if (!existsSync(REJECTED_PATH)) return new Set()
  const body = (await Bun.file(REJECTED_PATH).json()) as { ids?: string[] }
  return new Set(body.ids ?? [])
}

/**
 * Delete `files` and drop their credits so a re-run refills the slots.
 *
 * `ban` distinguishes the two reasons a file leaves:
 *   true  (`--reject`) — the PHOTO is wrong for its pool. Block its Openverse id
 *          so no future run anywhere can pick it again.
 *   false (`--drop`)   — the photo is fine, this COPY is redundant (the same id
 *          landed in two slots of one pool). Banning it would also throw away the
 *          surviving copy's right to exist; the in-pool id check is what stops it
 *          coming back to the freed slot.
 */
async function removeFiles(files: string[], { ban }: { ban: boolean }): Promise<void> {
  const creditsPath = path.join(MEDIA_DIR, 'credits.json')
  const credits = existsSync(creditsPath) ? ((await Bun.file(creditsPath).json()) as Credit[]) : []
  const byFile = new Map(credits.map((c) => [c.file, c]))
  const banned = await loadBanned()

  let removed = 0
  for (const raw of files) {
    const file = raw.replace(/^.*media\/cuisines\//, '')
    const credit = byFile.get(file)
    if (!credit) {
      console.warn(`  ! no credit entry for ${file} — deleting the file only`)
    } else {
      if (ban) banned.add(credit.openverse_id)
      byFile.delete(file)
    }
    await rm(path.join(MEDIA_DIR, file), { force: true })
    removed++
  }

  await writeFile(REJECTED_PATH, `${JSON.stringify({ ids: [...banned].sort() }, null, 2)}\n`)
  const kept = [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file))
  await writeFile(creditsPath, `${JSON.stringify(kept, null, 2)}\n`)
  console.log(
    `${ban ? 'Rejected' : 'Dropped'} ${removed} file(s); ${banned.size} id(s) blocked. Re-run to refill.`,
  )
}

/**
 * Find slots holding a photo another slot in the SAME pool already has — by
 * Openverse id, or by a title similar enough to be the same shoot. The
 * lowest-numbered slot wins; the rest are returned for `--drop`.
 *
 * These exist because until the `inPool` guard above, a top-up run chose from
 * candidates with no knowledge of the pool's surviving files, so the best hit for
 * a freed slot was often the photo already sitting next to it.
 */
async function findDuplicates(): Promise<string[]> {
  const creditsPath = path.join(MEDIA_DIR, 'credits.json')
  if (!existsSync(creditsPath)) return []
  const credits = (await Bun.file(creditsPath).json()) as Credit[]
  const byKey = new Map<string, Credit[]>()
  for (const c of credits) byKey.set(c.key, [...(byKey.get(c.key) ?? []), c])

  const dupes: string[] = []
  for (const pool of byKey.values()) {
    const ordered = [...pool].sort((a, b) => a.file.localeCompare(b.file))
    const ids = new Set<string>()
    const titles: Set<string>[] = []
    for (const c of ordered) {
      const words = wordsOf(c.title)
      if (ids.has(c.openverse_id) || tooSimilar(words, titles)) {
        dupes.push(c.file)
        continue
      }
      ids.add(c.openverse_id)
      titles.push(words)
    }
  }
  return dupes
}

// ---------------------------------------------------------------------------
// `--check`: the pools on disk are complete, and every cuisine tag the app can
// actually encounter maps to one.
//
// The second half is the one that rots. An unmapped tag is not a crash — it
// falls through to the `default` pool — so a new cuisine in the gateway seed, or
// a new member cuisine in the AI taxonomy, would quietly show generic restaurant
// photos forever. This reads both vocabularies from their source files and names
// anything TAG_TO_IMAGE_KEY has not been taught.
// ---------------------------------------------------------------------------

const SEED_PATH = path.resolve(HERE, '../../backend/gateway/prisma/seed.mjs')
const TAXONOMY_PATH = path.resolve(HERE, '../../backend/ai_service/app/ai/taxonomy.py')

/** Cuisine tags actually written onto restaurants by the gateway's Prisma seed. */
async function seedTags(): Promise<string[]> {
  if (!existsSync(SEED_PATH)) return []
  const body = await Bun.file(SEED_PATH).text()
  const tags = new Set<string>()
  for (const list of body.matchAll(/cuisine_tags:\s*\[([^\]]*)\]/g)) {
    for (const t of list[1].matchAll(/'([^']+)'/g)) tags.add(t[1])
  }
  return [...tags].sort()
}

/** Tags `taxonomy.py` can EMIT: group keys, umbrellas, members, style aliases. */
async function taxonomyTags(): Promise<string[]> {
  if (!existsSync(TAXONOMY_PATH)) return []
  const body = await Bun.file(TAXONOMY_PATH).text()
  const tags = new Set<string>()
  for (const name of ['CUISINE_GROUPS', 'RESTAURANT_STYLES']) {
    const start = body.indexOf(`${name}: dict`)
    if (start < 0) continue
    const block = body.slice(start, body.indexOf('\n}\n', start))
    for (const key of block.matchAll(/^ {4}"([a-z_]+)":\s*\{/gm)) tags.add(key[1])
    for (const field of ['seed_umbrella', 'members', 'seed_aliases']) {
      for (const arr of block.matchAll(new RegExp(`"${field}":\\s*\\[([\\s\\S]*?)\\]`, 'g'))) {
        for (const t of arr[1].matchAll(/"([a-z_]+)"/g)) tags.add(t[1])
      }
    }
  }
  return [...tags].sort()
}

async function check(): Promise<number> {
  let problems = 0

  const missing: string[] = []
  for (const key of CUISINE_IMAGE_KEYS) {
    for (let n = 1; n <= IMAGES_PER_CUISINE; n++) {
      const file = `${key}/${key}-${n}.jpg`
      if (!existsSync(path.join(MEDIA_DIR, file))) missing.push(file)
    }
  }
  const expected = CUISINE_IMAGE_KEYS.length * IMAGES_PER_CUISINE
  if (missing.length) {
    problems++
    console.error(`✗ ${missing.length}/${expected} image(s) missing: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ' …' : ''}`)
  } else {
    console.log(`✓ ${expected} images across ${CUISINE_IMAGE_KEYS.length} pools`)
  }

  // A CC BY image with no recorded attribution cannot ship, so an image on disk
  // with no credits.json entry is a licensing defect, not a cosmetic one.
  const creditsPath = path.join(MEDIA_DIR, 'credits.json')
  const credited = existsSync(creditsPath)
    ? new Set(((await Bun.file(creditsPath).json()) as Credit[]).map((c) => c.file))
    : new Set<string>()
  const uncredited: string[] = []
  for (const key of CUISINE_IMAGE_KEYS) {
    for (let n = 1; n <= IMAGES_PER_CUISINE; n++) {
      const file = `${key}/${key}-${n}.jpg`
      if (existsSync(path.join(MEDIA_DIR, file)) && !credited.has(file)) uncredited.push(file)
    }
  }
  if (uncredited.length) {
    problems++
    console.error(`✗ ${uncredited.length} image(s) have no attribution: ${uncredited.slice(0, 10).join(', ')}${uncredited.length > 10 ? ' …' : ''}`)
    console.error('  → --drop them and re-run; a CC BY file without its credit cannot ship')
  } else {
    console.log(`✓ every image has an attribution entry`)
  }

  for (const [label, tags] of [
    ['gateway seed', await seedTags()],
    ['ai taxonomy', await taxonomyTags()],
  ] as const) {
    if (tags.length === 0) {
      console.warn(`· ${label}: source file not found — skipped`)
      continue
    }
    const unmapped = tags.filter((t) => imageKeysForTags([t]).length === 0)
    if (unmapped.length) {
      problems++
      console.error(`✗ ${label}: ${unmapped.length}/${tags.length} tag(s) fall through to the default pool: ${unmapped.join(', ')}`)
      console.error('  → add them to TAG_TO_IMAGE_KEY in src/constants/cuisineImages.ts')
    } else {
      console.log(`✓ ${label}: all ${tags.length} cuisine tags map to a pool`)
    }
  }

  return problems
}

const argv = process.argv.slice(2)
const force = argv.includes('--force')
const rejectMode = argv.includes('--reject')
const dropMode = argv.includes('--drop')
const dedupeMode = argv.includes('--dedupe')
const borrowOnly = argv.includes('--borrow')
const checkMode = argv.includes('--check')
const rest = argv.filter((a) => !a.startsWith('--'))

if (!existsSync('/usr/bin/sips')) {
  console.warn('! `sips` not found — images will be saved at full size. Resize them before committing.')
}
await mkdir(MEDIA_DIR, { recursive: true })

if (checkMode) {
  process.exit((await check()) === 0 ? 0 : 1)
} else if (dedupeMode) {
  const dupes = await findDuplicates()
  if (dupes.length === 0) {
    console.log('✓ no duplicate photos within a pool')
  } else {
    console.log(`Dropping ${dupes.length} duplicate slot(s):\n  ${dupes.join('\n  ')}`)
    await removeFiles(dupes, { ban: false })
  }
} else if (rejectMode || dropMode) {
  if (rest.length === 0) {
    console.error(`${rejectMode ? '--reject' : '--drop'} needs one or more files, e.g. korean/korean-3.jpg`)
    process.exit(1)
  }
  await removeFiles(rest, { ban: rejectMode })
} else {
  const keys = (rest.length > 0 ? rest : CUISINE_IMAGE_KEYS).filter((k): k is CuisineImageKey =>
    (CUISINE_IMAGE_KEYS as readonly string[]).includes(k),
  )
  if (rest.length > 0 && keys.length !== rest.length) {
    console.error(`Unknown pool(s): ${rest.filter((k) => !keys.includes(k as CuisineImageKey)).join(', ')}`)
    process.exit(1)
  }

  const banned = await loadBanned()
  let total = 0
  for (const key of keys) {
    const credits = await fillPool(key, force, banned, borrowOnly)
    total += credits.length
    // Flush after EVERY pool, not once at the end. A run that dies partway (an
    // Openverse timeout took one down mid-sweep) would otherwise leave downloaded
    // files on disk with no recorded licence — and CC BY images without their
    // attribution are not usable, so those files would have to be thrown away.
    if (credits.length > 0) await writeCredits(credits)
  }
  console.log(`\nDone. ${total} new file(s) in ${MEDIA_DIR}`)
}
