// Explore-page visuals for data the `Restaurant` row doesn't carry: a soft tinted
// backdrop, and the rating cutoff behind the "Popular" badge. The tint is
// DETERMINISTIC (the same restaurant always gets the same one) and uses design
// tokens only, mirroring the client-side identity-color approach in
// constants/memberColors.ts.
//
// The tint used to BE the banner, alongside a per-cuisine emoji. Both are now the
// backdrop under a real cuisine photo (constants/cuisineImages.ts +
// components/restaurant/RestaurantImage.tsx) — the tint still carries the card
// while the JPEG decodes, or permanently if it never arrives. The emoji map went
// away with its last caller.

// Rating cutoff for the neutral "Popular" overlay badge. A restaurant at/above this
// avg_rating that the viewer hasn't liked reads as "Popular"; below it, no badge
// (rather than fabricating popularity for everything). Tunable in one place.
export const POPULAR_MIN = 4.5

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
