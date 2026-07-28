import { useEffect, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { GroupsSidebar } from '@/components/session/GroupsSidebar'
import { RankedRestaurantCard } from '@/components/restaurant/RankedRestaurantCard'
import { RestaurantHeader } from '@/components/restaurant/RestaurantHeader'
import { MenuList } from '@/components/restaurant/MenuList'
import { MobileHeader } from '@/components/layout/MobileHeader'
import { Button, Icon, Spinner } from '@/components/ui'
import { useDismissOnBack } from '@/hooks/useDismissOnBack'
import { useIsMobile } from '@/hooks/useIsMobile'
import { cn } from '@/utils/cn'
import {
  useSessionStore,
  selectSession,
  selectActiveSessionId,
  selectRecommendation,
  selectRecommendationLoading,
  selectRecommendationError,
  selectVotes,
  selectIsHost,
} from '@/stores/sessionStore'
import { useRestaurantStore } from '@/stores/restaurantStore'
import { useAuthStore } from '@/stores/authStore'
import { useNavStore } from '@/stores/navStore'
import { useSocket } from '@/hooks/useSocket'
import { EASE } from '@/lib/motion'
import { closeSession } from '@/api/sessionApi'

export function TopPicksPage() {
  const reduce = useReducedMotion()
  const go = useNavStore((s) => s.go)
  const groupId = useNavStore((s) => s.groupId)
  // Session state is keyed by group — read THIS group's slice via selectors.
  const session = useSessionStore(selectSession(groupId))
  const activeSessionId = useSessionStore(selectActiveSessionId(groupId))
  const recommendation = useSessionStore(selectRecommendation(groupId))
  const recommendationLoading = useSessionStore(selectRecommendationLoading(groupId))
  const recommendationError = useSessionStore(selectRecommendationError(groupId))
  const loadRecommendation = useSessionStore((s) => s.loadRecommendation)
  const votes = useSessionStore(selectVotes(groupId))
  const castVote = useSessionStore((s) => s.castVote)
  const chooseRestaurant = useSessionStore((s) => s.chooseRestaurant)
  const isHost = useSessionStore(selectIsHost(groupId))
  const byId = useRestaurantStore((s) => s.byId)
  const restaurantsLoaded = useRestaurantStore((s) => s.loaded)
  const loadRestaurants = useRestaurantStore((s) => s.load)
  const currentUserId = useAuthStore((s) => s.user?.id ?? 1)

  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [confirming, setConfirming] = useState(false)
  // Below `md` the 420px list + detail split becomes a drill-down: the list is the
  // screen, and tapping a card pushes the detail over it.
  const isMobile = useIsMobile()

  // Subscribe to the live socket while the results screen is up, so a session:picks
  // broadcast renders picks IMMEDIATELY instead of waiting for the next poll tick.
  // Without this the group-chat page is unmounted (its cleanup emits group:leave and
  // detaches session:picks), leaving polling as the only delivery path on this screen.
  // Same reasoning as AgentChatPage; the singleton socket makes the join idempotent.
  useSocket(groupId)

  useEffect(() => {
    if (!restaurantsLoaded) void loadRestaurants()
  }, [restaurantsLoaded, loadRestaurants])

  useEffect(() => {
    // Fetch once when we have a session but no rec yet — and NOT while a fetch is
    // in flight or after it errored (else this loops). Retry is user-driven via
    // the error state's button; a live session:picks socket delivery also fills it.
    if (session && !recommendation && !recommendationLoading && !recommendationError) {
      void loadRecommendation(groupId)
    }
  }, [session, recommendation, recommendationLoading, recommendationError, loadRecommendation, groupId])

  const picks = (recommendation?.items ?? [])
    .map((item) => {
      const restaurant = byId[item.restaurant_id]
      return restaurant
        ? { ...item, restaurant, voteCount: (votes[item.restaurant_id] ?? []).length }
        : null
    })
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
    // The results screen shows the group's Top 5.
    .slice(0, 5)

  // Default the detail panel to the top pick.
  const activeId = selectedId ?? picks[0]?.restaurant_id ?? null
  const active = picks.find((p) => p.restaurant_id === activeId)
  const activeRank = active ? picks.findIndex((p) => p.restaurant_id === active.restaurant_id) + 1 : 0

  // Mobile drill-down: keyed off `selectedId` specifically, NOT `activeId` — the
  // latter auto-selects the top pick, which would open the detail immediately and
  // hide the list the user is meant to land on. Back returns to the list.
  const mobileDetailOpen = isMobile && selectedId != null && active != null
  useDismissOnBack(mobileDetailOpen, () => setSelectedId(null))

  // Distinct results states (replacing a single permanent "Loading picks…"):
  //   loading → nothing renderable YET (no picks resolved against the catalog)
  //   error   → the read-back failed; offer a retry
  //   else    → a recommendation exists but nothing renders (no match / not loaded)
  //
  // Spin ONLY while there is nothing to show AND something is still coming. The
  // moment any pick resolves against the restaurant catalog, render it — gating on
  // `recommendationLoading || !restaurantsLoaded` instead would hold the spinner up
  // with renderable picks in hand (e.g. a socket delivery landing while the catalog
  // fetch is still in flight, or a stale loading flag). The in-flight clause keeps a
  // recommendation whose restaurants never resolve from spinning forever — it falls
  // through to the empty state as before.
  const picksStillComing = recommendationLoading || !restaurantsLoaded || !recommendation
  const isLoading = picks.length === 0 && !recommendationError && picksStillComing
  const isError = recommendationError && picks.length === 0

  const handleConfirm = async () => {
    if (activeId == null || confirming) return
    chooseRestaurant(groupId, activeId)
    const sessionId = activeSessionId ?? session?.id ?? null
    if (sessionId != null) {
      setConfirming(true)
      try {
        await closeSession(sessionId, activeId)
      } catch {
        // Surface nothing fatal — the confirm is idempotent-ish (409 if already
        // closed). Fall through to the completion screen regardless.
      } finally {
        setConfirming(false)
      }
    }
    go('session-complete')
  }

  // While the group's picks are still being fetched/generated, take over the whole
  // results area (everything right of the sidebar) with a single contained loading
  // screen — the GrubGroup loading circle — instead of an empty list beside a small
  // panel spinner. The sidebar stays put so the app frame never flickers.
  if (isLoading) {
    return (
      <div className="flex h-dvh overflow-hidden bg-surface">
        <GroupsSidebar />
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-text-muted">
          <Spinner size="lg" className="text-primary" />
          <div className="flex flex-col items-center gap-1 text-center">
            <p className="text-body font-medium text-text">Finding the group's picks…</p>
            <p className="max-w-xs text-caption text-text-muted">
              Matching everyone's preferences, budget, and location. This can take a moment.
            </p>
          </div>
        </div>
      </div>
    )
  }

  // Nothing renderable and nothing still coming — so this is either the read-back
  // error or a recommendation with no group-wide match. Both used to live INSIDE
  // the detail pane, which is hidden at phone width; taking over the whole results
  // area instead makes them reachable everywhere (and the list is empty regardless).
  if (picks.length === 0) {
    return (
      <div className="flex h-dvh overflow-hidden bg-surface">
        <GroupsSidebar />
        <div className="flex flex-1 flex-col overflow-y-auto">
          <MobileHeader className="md:hidden" onBack={() => go('group-chat')} title="Top picks" />
          {isError ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
              <p className="text-body font-medium text-text">Couldn't load results</p>
              <p className="max-w-xs text-caption text-text-muted">
                Something went wrong fetching the group's picks. Give it another try.
              </p>
              <Button variant="primary" size="sm" onClick={() => void loadRecommendation(groupId)}>
                Retry
              </Button>
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
              <p className="text-body font-medium text-text">No matching spots found</p>
              <p className="max-w-xs text-caption text-text-muted">
                We couldn't find restaurants that fit everyone's budget and location. Try a
                wider budget or a more central meeting spot next time.
              </p>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-dvh overflow-hidden bg-surface">
      <GroupsSidebar />

      {/* Center: ranked list. Full width below `md` — it IS the screen there — and
          the fixed 420px column at ≥md. Hidden while the mobile detail is pushed
          over it; at ≥md both columns always show. */}
      <div
        className={cn(
          'w-full shrink-0 flex-col overflow-y-auto border-r border-border bg-surface pb-safe-b md:w-[420px] md:pb-0',
          mobileDetailOpen ? 'hidden md:flex' : 'flex',
        )}
      >
        <div className="px-4 pb-2 pt-4">
          {/* Back to the group chat — same muted chevron style as Profile/Edit. */}
          <button
            onClick={() => go('group-chat')}
            className="tap-target mb-2 flex items-center gap-1 text-body text-text-muted hover:text-text"
          >
            <Icon name="chevron-left" size={14} /> Back
          </button>
          <h1 className="font-display text-panel-title font-bold text-text">Top picks for your group</h1>
          <p className="text-caption text-text-muted">
            Matched to everyone's preferences · vote for your favorite
          </p>
        </div>
        {picks.map((pick, i) => (
          <motion.div
            key={pick.restaurant_id}
            initial={{ opacity: 0, y: reduce ? 0 : 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: reduce ? 0.2 : 0.4, delay: reduce ? 0 : i * 0.07, ease: EASE }}
          >
            <RankedRestaurantCard
              rank={i + 1}
              pick={pick}
              selected={pick.restaurant_id === activeId}
              hasVoted={(votes[pick.restaurant_id] ?? []).includes(currentUserId)}
              onVote={() => castVote(groupId, pick.restaurant_id, currentUserId)}
              onSelect={() => setSelectedId(pick.restaurant_id)}
              showHours
            />
          </motion.div>
        ))}
      </div>

      {/* Right: live detail of the selected pick. At ≥md it's always the second
          column beside the list. Below `md` it's a PUSHED SCREEN — shown only once
          a card has been tapped, with its own back header instead of a chevron
          floating over the content. */}
      <div
        className={cn(
          'flex-1 flex-col overflow-y-auto',
          mobileDetailOpen ? 'flex' : 'hidden md:flex',
        )}
      >
        {active ? (
          <>
            <MobileHeader
              className="md:hidden"
              onBack={() => setSelectedId(null)}
              title={active.restaurant.name}
              // "#2 of 5" — the rank is on the list card, so carry it across the
              // push so the pushed screen still says where you are in the ranking.
              subtitle={`#${activeRank} of ${picks.length}`}
            />
            <div className="flex flex-col gap-5 p-4 md:p-6">
              <RestaurantHeader
                restaurant={active.restaurant}
                matchScorePct={active.match_score != null ? Math.round(active.match_score * 100) : undefined}
              />
              <MenuList restaurantId={active.restaurant_id} />
              {active.justification && (
                <div className="rounded-card bg-surface-sunken p-4">
                  <p className="mb-1 text-overline font-semibold uppercase tracking-wide text-text-muted">
                    Why it matched
                  </p>
                  <p className="text-body text-text-muted">{active.justification}</p>
                </div>
              )}
            </div>
            {/* Outer div carries pb-safe-b so the confirm CTA clears the iOS home
                indicator; the inner one keeps the constant 1rem padding. */}
            <div className="mt-auto shrink-0 border-t border-border bg-surface-raised pb-safe-b">
              <div className="p-4">
                {isHost ? (
                  <>
                    <Button
                      fullWidth
                      variant="primary"
                      isLoading={confirming}
                      onClick={() => void handleConfirm()}
                    >
                      Confirm this restaurant
                    </Button>
                    <p className="mt-2 text-center text-caption text-text-muted">
                      This creates the event and notifies your whole group
                    </p>
                  </>
                ) : (
                  <p className="text-center text-caption text-text-muted">
                    Vote for your favorite — the host confirms the final pick.
                  </p>
                )}
              </div>
            </div>
          </>
        ) : (
          // Only reachable if `selectedId` went stale against a re-ranked list —
          // picks are non-empty by here (the error/empty states return above).
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
            <p className="text-body font-medium text-text">Pick updated</p>
            <p className="max-w-xs text-caption text-text-muted">
              That spot is no longer in the group's top picks — choose another from the
              list.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
