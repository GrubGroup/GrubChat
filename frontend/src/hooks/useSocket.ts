import { useEffect } from 'react'
import type { GroupMessage, RecommendationItem } from '@/types'
import { getSocket } from '@/lib/socket'
import { useAuthStore } from '@/stores/authStore'
import { useGroupChatStore } from '@/stores/groupChatStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useEventListStore } from '@/stores/eventListStore'

// Connects to the gateway socket and wires live group chat + session sync for one
// group. While signed out getSocket() returns null and this is a no-op. Joins the
// group's room on mount, listens for chat + session events, and leaves on unmount.
export function useSocket(groupId: number) {
  const name = useAuthStore((s) => s.user?.display_name ?? s.user?.username)
  const currentUserId = useAuthStore((s) => s.user?.id)

  useEffect(() => {
    // Auth rides on the session cookie (withCredentials); we pass only the
    // cosmetic display name.
    const socket = getSocket({ name: name ?? undefined })
    if (!socket) return
    // Never join a room for the no-group sentinel / an invalid id (groupId 0 is
    // "no group selected" — see navStore). groupId is in the effect deps, so this
    // re-runs once a real id arrives.
    if (groupId <= 0) return

    socket.emit('group:join', { groupId })

    const handleMessage = (msg: GroupMessage) => {
      useGroupChatStore.getState().receiveMessage(msg)
    }
    socket.on('chat:message', handleMessage)

    // Persisted backlog replayed by the gateway right after we join the room.
    // A SESSION_BLOCK row already arrives with type:'session_block' + a parsed
    // `block`, so the picks card reconstructs on reload with no extra handling.
    const handleHistory = (payload: { groupId: number; messages: GroupMessage[] }) => {
      useGroupChatStore.getState().receiveHistory(payload.groupId, payload.messages)
    }
    socket.on('chat:history', handleHistory)

    // A member started a session. Show the inline card, and — when the host
    // included the new sessionId — adopt it so every member's client can drive
    // analyze/ready and shares one countdown anchored to the broadcast `at`.
    const handleSessionStart = (payload: {
      groupId: number
      sessionId?: number | null
      startedBy?: number | null
      at?: string
    }) => {
      // Defense in depth: only handle a broadcast for the room this hook joined.
      if (payload.groupId !== groupId) return
      useGroupChatStore.getState().receiveSessionStart(payload.groupId, payload.sessionId)
      if (payload.sessionId != null) {
        const store = useSessionStore.getState()
        // The host already set the session locally via the modal; others load it.
        // Read THIS group's slice to tell the two apart.
        if (store.byGroup[payload.groupId]?.activeSessionId !== payload.sessionId) {
          void store.load(payload.groupId, payload.sessionId, currentUserId ?? store.currentUserId)
        } else {
          // Host path: the session is already adopted, so load() is skipped — but
          // the create response carried no member names. Hydrate the roster so the
          // host's own avatar/roster shows real names instead of "User N".
          void store.hydrateMembers(payload.groupId, payload.sessionId)
        }
        if (payload.at) store.setStartedAt(payload.groupId, payload.at)
      }
    }
    socket.on('session:start', handleSessionStart)

    // Live progress: a member finished sharing. Reconcile from the server counts
    // so every client's progress bar + roster update from the echo. The gateway
    // stamps groupId + sessionId on this event (sessionsController.js), so we can
    // attribute it to the RIGHT group's slice and reject a stale echo: only apply
    // when it's for the room this hook joined AND matches that group's live
    // session id — otherwise a member_done for group A, delivered during an A→B
    // switch, could flip "you finished" in B.
    const handleMemberDone = (payload: {
      groupId: number
      sessionId: number
      doneCount: number
      total: number
      userId: number
      status: boolean
      // Set by the gateway on host force-finish / timer expiry: the whole session is
      // done. Flips every member's card to complete at once (the shared finalizing
      // state), not just the one user in the payload.
      allDone?: boolean
    }) => {
      if (payload.groupId !== groupId) return
      const store = useSessionStore.getState()
      if (store.byGroup[payload.groupId]?.activeSessionId !== payload.sessionId) return
      store.applyProgress(
        payload.groupId,
        payload.doneCount,
        payload.total,
        payload.userId,
        payload.status,
        payload.allDone ?? false,
      )
    }
    socket.on('session:member_done', handleMemberDone)

    // The orchestrator's top-5 is ready. Recommendations live in the session /
    // results flow — NOT the group chat — so adopt them into the session store
    // (which surfaces the "Results" affordance); navigation stays user-driven.
    const handlePicks = (payload: {
      groupId: number
      sessionId: number
      recommendationId: number
      items: RecommendationItem[]
    }) => {
      // Defense in depth: only handle picks for the room this hook joined; then
      // adopt them into THAT group's slice.
      if (payload.groupId !== groupId) return
      useSessionStore.getState().receivePicks(payload.groupId, {
        recommendationId: payload.recommendationId,
        sessionId: payload.sessionId,
        items: payload.items,
      })
    }
    socket.on('session:picks', handlePicks)

    // The host confirmed a restaurant → an Event was created. Refresh the Events
    // tab list so it appears without a manual reload.
    const handleConfirmed = () => {
      void useEventListStore.getState().load()
    }
    socket.on('session:confirmed', handleConfirmed)

    // The previous host deleted their account, so the gateway handed the open
    // session off to another member. Repoint host_user_id so the new host's
    // "Close session" control appears without a refresh (selectIsHost re-derives),
    // and the departed host drops off the roster. Guard to this room + live session.
    const handleHostChanged = (payload: {
      groupId: number
      sessionId: number
      newHostId: number
    }) => {
      if (payload.groupId !== groupId) return
      useSessionStore
        .getState()
        .applyHostChange(payload.groupId, payload.sessionId, payload.newHostId)
    }
    socket.on('session:host_changed', handleHostChanged)

    const handleTyping = (payload: {
      groupId: number
      userId: number | null
      name: string | null
      isTyping: boolean
    }) => {
      useGroupChatStore.getState().receiveTyping(payload)
    }
    socket.on('typing:update', handleTyping)

    return () => {
      socket.emit('group:leave', { groupId })
      socket.off('chat:message', handleMessage)
      socket.off('chat:history', handleHistory)
      socket.off('session:start', handleSessionStart)
      socket.off('session:member_done', handleMemberDone)
      socket.off('session:picks', handlePicks)
      socket.off('session:confirmed', handleConfirmed)
      socket.off('session:host_changed', handleHostChanged)
      socket.off('typing:update', handleTyping)
    }
  }, [name, currentUserId, groupId])
}
