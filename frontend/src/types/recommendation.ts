import type { Restaurant } from './restaurant'

// Modeled on Prisma `Recommendation` + `RecommendationItem`.
//
// `id` / `recommendation_id` are OPTIONAL: the live gateway responses
// (`getLatestRecommendation` and the `POST .../recommendations` proxy that
// delivers picks into the group chat) carry only `restaurant_id` / `match_score`
// / `justification` on each item — plus `name` and, on the generate path,
// `hours` / `is_open` enriched from the pipeline candidates. The mock fixture
// carries the full row shape. `is_open` is the venue's open/closed state at the
// session's chosen event time (null when no time was set → unknown, not closed).
export interface RecommendationItem {
  id?: number
  recommendation_id?: number
  restaurant_id: number
  match_score?: number | null
  justification?: string | null
  name?: string | null
  hours?: string | null
  is_open?: boolean | null
  // Full restaurant row embedded by the gateway (all delivery paths), so a pick
  // renders without joining against the ≤100-row restaurant catalog store. The
  // TopPicks join prefers this and falls back to restaurantStore.byId when absent.
  restaurant?: Restaurant | null
}

export interface Recommendation {
  id: number
  session_id: number
  created_at: string
  items: RecommendationItem[]
}

// VIEW TYPE (not persisted): a recommendation item joined with its restaurant
// and the live vote count, composed in the store for the TopPicks UI.
export interface RankedPick extends RecommendationItem {
  restaurant: Restaurant
  voteCount: number
}
