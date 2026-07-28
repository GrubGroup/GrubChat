import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router'
import type { RecommendationItem } from '@/types'
import { getSocket } from '@/lib/socket'
import { idFromSlug } from '@/utils/slug'
import { useAuthStore } from '@/stores/authStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useGroupChatStore } from '@/stores/groupChatStore'
import { useEventListStore } from '@/stores/eventListStore'

// Routes a member could be viewing/awaiting THIS session's results from when the host
// confirms — pull them back to the group chat. Everything under a group's `/sessions/`
// subtree qualifies: the agent chat, its `/done` state, and the results page. Someone
// already on the group chat needs no redirect (the card just vanishes there), and this
// deliberately matches nothing else, so a member browsing Events or Profile is never
// teleported. Capture group 1 is the group slug, which carries the authoritative id at
// its tail — reusing it for the destination keeps the readable URL intact.
//
// This mirrors the route tree in App.tsx: if the session path segment ever changes,
// this pattern must change with it, or the confirm-redirect silently stops firing.
const SESSION_ROUTE = /^\/groups\/([^/]+)\/sessions(?:\/|$)/

// The AGENT-CHAT screens a member sits on WHILE the session runs: the live chat
// (`/sessions/:id`) and its "you're done, waiting for the group" state
// (`/sessions/:id/done`). Deliberately does NOT match the results page
// (`/sessions/:id/picks`) — someone already viewing results must not be yanked —
// nor the group chat or anywhere else. Capture group 1 is the group slug (id at
// its tail). Used to auto-forward a member to the results page the moment picks
// land (e.g. the session timer expired), so they don't have to leave the chat by
// hand. Mirror App.tsx's session route tree; if it changes, change this too.
const AGENT_CHAT_ROUTE = /^\/groups\/([^/]+)\/sessions\/[^/]+(?:\/done)?$/

// App-level session sync. Adopts session:picks regardless of the current screen —
// group chat OR the results page (TopPicksPage), where useSocket is NOT mounted and
// the user has already left the group room (useSocket's unmount emits group:leave).
// Delivery reaches here via the gateway's per-user room broadcast (broadcastPicks in
// sessionsController), so a host who force-finishes and every member sees the ranked
// picks live — no wait on the HTTP round-trip, no page reload. Routes each event to
// the correct group's slice by payload.groupId. No-op in mock mode (getSocket()
// returns null) and while signed out. receivePicks is idempotent, so overlapping with
// useSocket's own session:picks handler on the chat page is harmless.
export function useSessionSync() {
  const userId = useAuthStore((s) => s.user?.id)
  const navigate = useNavigate()
  const { pathname } = useLocation()
  // The socket subscription is keyed on userId alone — re-binding listeners on every
  // navigation would drop events mid-flight. So the confirm handler reads the current
  // path from a ref instead of closing over it, which would otherwise go stale the
  // moment the user moves between session screens.
  const pathRef = useRef(pathname)
  useEffect(() => {
    pathRef.current = pathname
  }, [pathname])

  useEffect(() => {
    if (!userId) return
    const socket = getSocket()
    if (!socket) return

    const handlePicks = (p: {
      groupId: number
      sessionId: number
      recommendationId: number
      items: RecommendationItem[]
    }) => {
      useSessionStore.getState().receivePicks(p.groupId, {
        recommendationId: p.recommendationId,
        sessionId: p.sessionId,
        items: p.items,
      })
      // Picks are ready (all members finished, or the timer expired and the host's
      // client force-generated). Auto-forward a member still sitting in THIS group's
      // agent chat straight to the results page, so they don't have to leave the chat
      // by hand. Scoped to the agent-chat screens only — a member already on the
      // results page, the group chat, or elsewhere is left alone. `replace` keeps the
      // dead chat URL out of history so Back doesn't return to a finished session.
      const match = AGENT_CHAT_ROUTE.exec(pathRef.current)
      if (match && idFromSlug(match[1]) === p.groupId) {
        navigate(`/groups/${match[1]}/sessions/${p.sessionId}/picks`, { replace: true })
      }
    }
    socket.on('session:picks', handlePicks)

    // Live restaurant voting on the results page (ephemeral, never persisted). The
    // gateway relays vote:cast → vote:update to each member's per-user room, so a
    // voter on the results page (who has left the group room) still gets everyone's
    // votes live. Idempotent single-choice toggle keyed by the payload's voter id.
    const handleVote = (p: { groupId: number; restaurantId: number; userId: number }) => {
      useSessionStore.getState().receiveVote(p.groupId, p.restaurantId, p.userId)
    }
    socket.on('vote:update', handleVote)

    // The host confirmed a restaurant → the session is closed and an Event created.
    // Mark this group's session complete/closed for every member, refresh the Events
    // list, and pull anyone still viewing THIS session's results/complete screen back
    // to the group chat (where the confirmation SYSTEM message + closed card show).
    // Delivery reaches results-page viewers via the per-user room (they've left the
    // group room). Guarded so we never teleport someone browsing elsewhere.
    const handleConfirmed = (p: { groupId: number; closedAt?: string }) => {
      // Mark the session closed (phase:'complete' + closed_at) AND clear the group-chat
      // card marker so the inline session card DISAPPEARS for everyone — close() alone
      // only flips it to "Session complete"; the card is gated on sessionStartIndex,
      // which lives in groupChatStore and must be cleared here.
      useSessionStore.getState().close(p.groupId)
      useGroupChatStore.getState().clearSessionStart(p.groupId)
      void useEventListStore.getState().load()
      // Only pull back someone sitting on a session screen OF THE GROUP that just
      // confirmed. `replace` keeps the now-dead session URL out of the history stack,
      // so Back doesn't return them to a closed session.
      const match = SESSION_ROUTE.exec(pathRef.current)
      if (match && idFromSlug(match[1]) === p.groupId) {
        navigate(`/groups/${match[1]}`, { replace: true })
      }
    }
    socket.on('session:confirmed', handleConfirmed)

    return () => {
      socket.off('session:picks', handlePicks)
      socket.off('vote:update', handleVote)
      socket.off('session:confirmed', handleConfirmed)
    }
  }, [userId, navigate])
}
