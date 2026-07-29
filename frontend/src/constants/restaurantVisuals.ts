// Explore-page visuals for data the `Restaurant` row doesn't carry — an emoji
// "banner" and a soft tinted backdrop behind it. Both are DETERMINISTIC (the same
// restaurant always looks the same) and use design tokens only, mirroring the
// client-side identity-color approach in constants/memberColors.ts.

// Rating cutoff for the neutral "Popular" overlay badge. A restaurant at/above this
// avg_rating that the viewer hasn't liked reads as "Popular"; below it, no badge
// (rather than fabricating popularity for everything). Tunable in one place.
export const POPULAR_MIN = 4.5

// cuisine token → emoji, keyed on the controlled CUISINES vocabulary
// (constants/dietary.ts). The first mapped tag on a restaurant wins; anything
// unmapped falls back to a generic plate.
const CUISINE_EMOJI: Record<string, string> = {
  american: '🍔',
  mexican: '🌮',
  'latin-american': '🫓',
  caribbean: '🍹',
  cajun: '🦐',
  peruvian: '🐟',
  chinese: '🥡',
  japanese: '🍣',
  thai: '🍜',
  vietnamese: '🍲',
  korean: '🍚',
  taiwanese: '🧋',
  filipino: '🍢',
  cantonese: '🥟',
  indonesian: '🍛',
  burmese: '🍜',
  indian: '🍛',
  pakistani: '🍛',
  nepalese: '🥟',
  italian: '🍝',
  greek: '🥙',
  french: '🥐',
  spanish: '🥘',
  mediterranean: '🫒',
  british: '🥧',
  georgian: '🍖',
  'middle-eastern': '🧆',
  lebanese: '🧆',
  turkish: '🥙',
  persian: '🍢',
  ethiopian: '🍲',
  african: '🍲',
  moroccan: '🍲',
}

const DEFAULT_EMOJI = '🍽️'

// Pick a stable emoji for a restaurant from its cuisine tags (first mapped tag wins).
export function restaurantEmoji(cuisineTags: string[]): string {
  for (const tag of cuisineTags) {
    const emoji = CUISINE_EMOJI[tag]
    if (emoji) return emoji
  }
  return DEFAULT_EMOJI
}

// Soft banner tints — FULL literal class strings (Tailwind's scanner can't resolve
// `bg-${x}`), the same constraint constants/memberColors.ts + GroupsPage's MemberDot
// work under. Low-opacity brand/member tokens give the muted pastel banners the
// wireframe uses.
const TINT_PALETTE = [
  'bg-member-green/10',
  'bg-primary/10',
  'bg-member-pink/10',
  'bg-member-blue/10',
  'bg-member-amber/10',
  'bg-member-purple/10',
] as const

// Deterministic tint from the restaurant id — stable across renders and sessions.
export function restaurantTint(id: number): string {
  const i = ((id % TINT_PALETTE.length) + TINT_PALETTE.length) % TINT_PALETTE.length
  return TINT_PALETTE[i]
}
