import { useEffect, useMemo, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { Button, Icon, Input, Skeleton } from '@/components/ui'
import { AppSidebar } from '@/components/layout/AppSidebar'
import { BottomTabBar, TabBarSpacer } from '@/components/layout/BottomTabBar'
import { MobileHeader } from '@/components/layout/MobileHeader'
import { ExploreFilters } from '@/components/restaurant/ExploreFilters'
import { LikedPlacesPanel } from '@/components/restaurant/LikedPlacesPanel'
import { RestaurantExploreCard } from '@/components/restaurant/RestaurantExploreCard'
import { useExploreFilters } from '@/hooks/useExploreFilters'
import { useProfileStore } from '@/stores/profileStore'
import { useRestaurantStore } from '@/stores/restaurantStore'
import { EASE } from '@/lib/motion'

// Browse the restaurant catalog and like places — the liked ids persist to
// Profile.liked_restaurant_ids, the signal each member's preference agent reads.
// Structure mirrors EventsPage: a left AppSidebar panel (here, "Liked places") + a
// flex-1 main column, with the mobile chrome (MobileHeader / BottomTabBar) taking
// over below `md`.
export function ExplorePage() {
  const reduce = useReducedMotion()

  const byId = useRestaurantStore((s) => s.byId)
  const loaded = useRestaurantStore((s) => s.loaded)
  const error = useRestaurantStore((s) => s.error)
  const loadRestaurants = useRestaurantStore((s) => s.load)

  const profile = useProfileStore((s) => s.profile)
  const loadProfile = useProfileStore((s) => s.load)
  const toggleLike = useProfileStore((s) => s.toggleLikedRestaurant)
  const likePending = useProfileStore((s) => s.likePending)

  useEffect(() => {
    if (!loaded) void loadRestaurants()
  }, [loaded, loadRestaurants])
  useEffect(() => {
    if (!profile) void loadProfile()
  }, [profile, loadProfile])

  const all = useMemo(() => Object.values(byId), [byId])
  const likedIds = useMemo(() => profile?.liked_restaurant_ids ?? [], [profile?.liked_restaurant_ids])
  const likedSet = useMemo(() => new Set(likedIds), [likedIds])
  // Liked restaurants, resolved against the catalog (same pattern as ProfilePage).
  const liked = useMemo(() => likedIds.map((id) => byId[id]).filter(Boolean), [likedIds, byId])

  // Home coords drive distance + the Nearby sort; absent → both are dropped.
  const userCoords = useMemo(() => {
    const lat = profile?.default_lat
    const lon = profile?.default_lon
    return lat != null && lon != null ? { lat, lon } : undefined
  }, [profile?.default_lat, profile?.default_lon])

  // Snapshot "now" once (the Open-now cutoff). A mid-view tick isn't worth a re-render.
  const [now] = useState(() => new Date())

  const { search, setSearch, active, toggle, clearFilters, reset, results, count, countLabel, canUseNearby, distances } =
    useExploreFilters(all, { userCoords, now })

  const searchBar = (
    <Input
      inputSize="sm"
      leftIcon={<Icon name="search" size={14} />}
      placeholder="Search restaurants or cuisines"
      aria-label="Search restaurants or cuisines"
      value={search}
      onChange={(e) => setSearch(e.target.value)}
    />
  )

  return (
    <div className="flex h-dvh overflow-hidden bg-surface-raised">
      {/* Desktop sidebar — the "Liked places" panel. */}
      <AppSidebar eyebrow="Explore" panelWidth="w-72">
        <LikedPlacesPanel liked={liked} pending={likePending} onToggleLike={(id) => void toggleLike(id)} />
      </AppSidebar>

      {/* Main browse column. */}
      <div className="flex flex-1 flex-col overflow-y-auto">
        <MobileHeader className="md:hidden" brand title="Explore" />

        {/* Desktop header — title + subtitle with the search on the right. */}
        <div className="hidden border-b border-border px-6 py-5 md:block">
          <div className="flex items-start justify-between gap-6">
            <div className="min-w-0">
              <h1 className="font-display text-display font-bold text-text">Explore restaurants</h1>
              <p className="mt-1 text-body text-text-muted">
                Like places you love — your agent factors them into every group pick
              </p>
            </div>
            <div className="w-80 shrink-0">{searchBar}</div>
          </div>
        </div>

        <div className="flex flex-col gap-5 px-4 py-5 md:px-6">
          {/* Mobile search (the desktop one lives in the header row above). */}
          <div className="md:hidden">{searchBar}</div>

          <ExploreFilters
            active={active}
            onToggle={toggle}
            onClearFilters={clearFilters}
            canUseNearby={canUseNearby}
          />

          {!loaded ? (
            <SkeletonGrid />
          ) : error && all.length === 0 ? (
            <ExploreErrorState onRetry={() => void loadRestaurants()} />
          ) : (
            <>
              {/* Liked places as a section above the grid on mobile (the sidebar
                  panel is hidden there). Only when non-empty, to keep browse grid-first. */}
              {liked.length > 0 && (
                <div className="overflow-hidden rounded-card border border-border md:hidden">
                  <LikedPlacesPanel
                    liked={liked}
                    pending={likePending}
                    onToggleLike={(id) => void toggleLike(id)}
                  />
                </div>
              )}

              <p className="text-overline font-semibold uppercase tracking-wide text-text-muted">
                {countLabel}
              </p>

              {count === 0 ? (
                <ExploreEmptyResults onClear={reset} />
              ) : (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {results.map((r, i) => (
                    <motion.div
                      key={r.id}
                      initial={{ opacity: 0, y: reduce ? 0 : 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{
                        duration: reduce ? 0.2 : 0.35,
                        // Cap the stagger so a large grid doesn't ripple for seconds.
                        delay: reduce ? 0 : Math.min(i, 8) * 0.05,
                        ease: EASE,
                      }}
                    >
                      <RestaurantExploreCard
                        restaurant={r}
                        liked={likedSet.has(r.id)}
                        pending={likePending.has(r.id)}
                        distanceMi={distances[r.id]}
                        onToggleLike={() => void toggleLike(r.id)}
                      />
                    </motion.div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <TabBarSpacer />
      </div>

      <BottomTabBar />
    </div>
  )
}

// Placeholder grid while the catalog is loading — 6 cards echoing the real layout.
function SkeletonGrid() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="overflow-hidden rounded-card border border-border">
          <Skeleton className="h-28 w-full rounded-none" />
          <div className="flex flex-col gap-2 p-4">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  )
}

// Shown when GET /api/restaurants failed and we have nothing cached — an honest
// error with a retry, mirroring EventsPage's error state.
function ExploreErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-border bg-surface-raised text-2xl">
        🍽️
      </span>
      <p className="text-body font-medium text-text">Couldn't load restaurants</p>
      <p className="max-w-xs text-caption text-text-muted">
        Something went wrong fetching the catalog. Give it another try.
      </p>
      <Button variant="primary" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  )
}

// Shown when the search/filters exclude everything (the catalog loaded fine).
function ExploreEmptyResults({ onClear }: { onClear: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-border bg-surface-raised text-2xl">
        🔍
      </span>
      <p className="text-body font-medium text-text">No places match your filters</p>
      <p className="max-w-xs text-caption text-text-muted">
        Try removing a filter or clearing your search.
      </p>
      <Button variant="ghost" size="sm" className="border border-border" onClick={onClear}>
        Clear filters
      </Button>
    </div>
  )
}
