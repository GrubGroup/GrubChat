import { useEffect } from 'react'
import type { RecommendationItem } from '@/types'
import { getSocket } from '@/lib/socket'
import { useAuthStore } from '@/stores/authStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useGroupChatStore } from '@/stores/groupChatStore'
import { useNavStore } from '@/stores/navStore'
import { useEventListStore } from '@/stores/eventListStore'

// Screens a member could be viewing/awaiting THIS session's results from when the host
// confirms — pull them back to the group chat. Covers the results context (top-picks,
// session-complete) AND the agent-chat context (a finisher waiting on agent-chat-done,
// or still mid-chat). Someone already on group-chat needs no redirect — the card just
// vanishes there.
const CONFIRM_REDIRECT_SCREENS = [
  'top-picks',
  'session-complete',
  'agent-chat-done',
  'agent-chat',
  'voice',
]

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
      const nav = useNavStore.getState()
      if (nav.groupId === p.groupId && CONFIRM_REDIRECT_SCREENS.includes(nav.screen)) {
        nav.go('group-chat')
      }
    }
    socket.on('session:confirmed', handleConfirmed)

    return () => {
      socket.off('session:picks', handlePicks)
      socket.off('vote:update', handleVote)
      socket.off('session:confirmed', handleConfirmed)
    }
  }, [userId])
}
