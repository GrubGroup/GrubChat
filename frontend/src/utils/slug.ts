// URL slug helpers for group / event routes. The route param carries a readable
// prefix plus the authoritative numeric id at the tail — e.g. `foodie-friends-42`.
// The name prefix is cosmetic; only the trailing id is ever trusted for lookups,
// so a bare `42` (legacy link) or a stale name still resolves correctly.

// Build a URL-safe, lowercase, kebab-case prefix from a display name. Strips
// accents, drops non-alphanumerics, collapses and trims dashes. Empty name -> "".
export function slugify(name: string | null | undefined): string {
  return (name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // drop combining accents left by NFKD
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// "<slug>-<id>" — the id is the authoritative tail. If the name slugifies to
// nothing, fall back to the bare id (still a valid, resolvable URL).
export function toSlugId(name: string | null | undefined, id: number): string {
  const s = slugify(name)
  return s ? `${s}-${id}` : String(id)
}

// Pull the trailing numeric id back out of a slug (or a bare number).
// "foodie-friends-42" -> 42, "42" -> 42, malformed -> NaN. NaN is a safe
// sentinel: keyed stores fall back to empty and `NaN > 0` is false, matching
// the pre-existing useGroupId contract.
export function idFromSlug(slug: string | undefined): number {
  if (!slug) return NaN
  const m = slug.match(/(\d+)$/)
  return m ? Number(m[1]) : NaN
}
