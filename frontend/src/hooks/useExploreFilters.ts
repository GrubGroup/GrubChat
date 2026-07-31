import { useCallback, useMemo, useState } from 'react'
import type { Restaurant } from '@/types'
import { isOpenAt } from '@/utils/hours'
import { priceLevel } from '@/utils/price'
import { distanceMi, type Coords } from '@/utils/distance'

// Explore browse state — search + filter/sort chips + "show more" pagination —
// derived entirely client-side over the already-cached catalog (~2k+ rows in
// restaurantStore). The gateway list endpoint exposes no search/dietary/open-now
// params, and "Open now" already lives client-side (utils/hours), so server
// round-trips per keystroke would only add latency and duplicate logic.
//
// "All" === an empty active set. Sort chips are mutually exclusive with EACH OTHER
// (a list has one order) but coexist with the additive AND filters.
const SORT_KEYS = new Set(['nearby', 'top-rated'])

// How many cards to reveal per page (initial + each "Show more").
const PAGE_SIZE = 12

export interface UseExploreFiltersOptions {
  // The user's saved home location, when set (Profile.default_lat/lon). Absent →
  // no distance line, no "Nearby" sort, and the count label drops "NEAR YOU".
  userCoords?: Coords
  // Snapshot of "now" for the Open-now predicate (pass a stable value from state).
  now: Date
}

export interface UseExploreFiltersResult {
  search: string
  setSearch: (s: string) => void
  active: Set<string>
  toggle: (key: string) => void
  clearFilters: () => void
  reset: () => void
  results: Restaurant[]
  // The currently-revealed slice of `results` (pagination). Render this in the grid.
  visible: Restaurant[]
  hasMore: boolean
  remaining: number
  showMore: () => void
  count: number
  total: number
  countLabel: string
  canUseNearby: boolean
  // Precomputed miles from the user's home location, keyed by restaurant id (empty
  // when no home location is set). Cards read their own distance from here.
  distances: Record<number, number>
}

export function useExploreFilters(
  all: Restaurant[],
  { userCoords, now }: UseExploreFiltersOptions,
): UseExploreFiltersResult {
  const [search, setSearchState] = useState('')
  const [active, setActive] = useState<Set<string>>(() => new Set())
  // How many results are revealed. Reset to the first page whenever the query or
  // filters change (done here, in the handlers, to avoid a setState-in-effect).
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)

  const setSearch = useCallback((s: string) => {
    setSearchState(s)
    setVisibleCount(PAGE_SIZE)
  }, [])

  const toggle = useCallback((key: string) => {
    setVisibleCount(PAGE_SIZE)
    setActive((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        // Turning on a sort clears the other sort, so only one ordering is active.
        if (SORT_KEYS.has(key)) for (const k of SORT_KEYS) next.delete(k)
        next.add(key)
      }
      return next
    })
  }, [])

  const clearFilters = useCallback(() => {
    setActive(new Set())
    setVisibleCount(PAGE_SIZE)
  }, [])
  const reset = useCallback(() => {
    setActive(new Set())
    setSearchState('')
    setVisibleCount(PAGE_SIZE)
  }, [])

  const showMore = useCallback(() => setVisibleCount((c) => c + PAGE_SIZE), [])

  const distances = useMemo(() => {
    const out: Record<number, number> = {}
    if (!userCoords) return out
    for (const r of all) {
      if (r.lat != null && r.long != null) {
        out[r.id] = distanceMi(userCoords, { lat: r.lat, lon: r.long })
      }
    }
    return out
  }, [all, userCoords])

  const results = useMemo(() => {
    const q = search.trim().toLowerCase()
    const filtered = all.filter((r) => {
      if (q) {
        const hay = [r.name, ...(r.cuisine_tags ?? []), ...(r.dietary_tags ?? [])]
          .join(' ')
          .toLowerCase()
        if (!hay.includes(q)) return false
      }
      if (active.has('vegan') && !r.dietary_tags?.includes('vegan')) return false
      if (active.has('gluten-free') && !r.dietary_tags?.includes('gluten-free')) return false
      if (active.has('budget')) {
        const lvl = priceLevel(r.price_avg)
        if (!lvl || lvl.length > 2) return false
      }
      if (active.has('open') && !isOpenAt(r.hours, now)) return false
      return true
    })

    // Sorts return a copy so the store's array is never mutated in place.
    if (active.has('top-rated')) {
      return [...filtered].sort((a, b) => (b.avg_rating ?? -Infinity) - (a.avg_rating ?? -Infinity))
    }
    if (active.has('nearby') && userCoords) {
      return [...filtered].sort(
        (a, b) => (distances[a.id] ?? Infinity) - (distances[b.id] ?? Infinity),
      )
    }
    return filtered
  }, [all, active, search, now, userCoords, distances])

  const count = results.length
  const visible = useMemo(() => results.slice(0, visibleCount), [results, visibleCount])
  const hasMore = count > visibleCount
  const remaining = Math.max(0, count - visibleCount)
  const countLabel = `${userCoords ? 'NEAR YOU · ' : ''}${count} ${count === 1 ? 'PLACE' : 'PLACES'}`

  return {
    search,
    setSearch,
    active,
    toggle,
    clearFilters,
    reset,
    results,
    visible,
    hasMore,
    remaining,
    showMore,
    count,
    total: all.length,
    countLabel,
    canUseNearby: !!userCoords,
    distances,
  }
}
