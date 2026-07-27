import { useEffect } from 'react'
import type { RecommendationItem } from '@/types'
import { getSocket } from '@/lib/socket'
import { useAuthStore } from '@/stores/authStore'
import { useSessionStore } from '@/stores/sessionStore'

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

    return () => {
      socket.off('session:picks', handlePicks)
    }
  }, [userId])
}
