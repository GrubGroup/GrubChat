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

// The screens a member sits on WHILE a session runs, from which they should be
// auto-forwarded to the results page the moment picks land (host force-finish,
// timer expiry, or everyone finishing — all broadcast session:picks): the group
// chat (`/groups/:slug`), the live agent chat (`/sessions/:id`), and its "waiting"
// state (`/sessions/:id/done`). Deliberately does NOT match the results page
// itself (`/sessions/:id/picks`) — someone already viewing results must not be
// yanked — nor Events / Profile / anywhere else. Capture group 1 is the group slug
// (authoritative id at its tail). Mirror App.tsx's route tree; if the group/session
// paths change, change this too.
const RESULTS_REDIRECT_ROUTE = /^\/groups\/([^/]+)(?:\/sessions\/[^/]+(?:\/done)?)?$/

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
      // Picks are ready — via host force-finish, timer expiry, or everyone finishing
      // (all three broadcast session:picks). Auto-forward EVERY member sitting on
      // THIS group's chat or agent chat straight to the results page, so the whole
      // group lands there together without leaving by hand. A member already on the
      // results page (or off in Events/Profile) is left alone. `replace` keeps the
      // now-dead chat URL out of history.
      const match = RESULTS_REDIRECT_ROUTE.exec(pathRef.current)
      if (match && idFromSlug(match[1]) === p.groupId) {
        navigate(`/groups/${match[1]}/sessions/${p.sessionId}/picks`, { replace: true })
      }
    }
    socket.on('session:picks', handlePicks)

    // Session finalized — the host force-finished or the timer expired
    // (session:member_done with allDone:true), which arrives IMMEDIATELY, before the
    // recommendation is generated (picks can take up to ~120s). Forward every member
    // still on this group's chat/agent-chat to the results page NOW, so they don't
    // sit on the "Session complete" card waiting; the picks page shows its own loading
    // state until generation lands. Only acts on allDone (a single member finishing
    // must not move anyone). Same route guard as handlePicks; the later session:picks
    // redirect is then a no-op since they're already on /picks.
    const handleMemberDone = (p: {
      groupId: number
      sessionId: number
      allDone?: boolean
    }) => {
      if (!p.allDone) return
      const match = RESULTS_REDIRECT_ROUTE.exec(pathRef.current)
      if (match && idFromSlug(match[1]) === p.groupId) {
        navigate(`/groups/${match[1]}/sessions/${p.sessionId}/picks`, { replace: true })
      }
    }
    socket.on('session:member_done', handleMemberDone)

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

    // A new session started in one of the user's groups. useSocket already adopts
    // this via the GROUP room while the member is viewing that group — but a member
    // who has navigated away (Events / Profile / another group) has left the group
    // room and misses it, leaving that group's slice bound to its now-auto-closed
    // prior session until a reload. Delivered here via the per-user room
    // (sessionHandlers), so adopt the new session into that group's slice in the
    // background. Skip when the member is currently on that group's own pages —
    // useSocket owns the adoption there, so acting would only cause a redundant load.
    const handleSessionStart = (p: {
      groupId: number
      sessionId?: number | null
      at?: string
    }) => {
      if (p.sessionId == null) return
      // On that group's chat / agent-chat / results pages, useSocket(groupId) is
      // mounted and handles this. The slug's tail carries the authoritative id.
      const m = /^\/groups\/([^/]+)/.exec(pathRef.current)
      if (m != null && idFromSlug(m[1]) === p.groupId) return
      const store = useSessionStore.getState()
      // Duplicate delivery (already bound to this session) — nothing to do.
      if (store.byGroup[p.groupId]?.activeSessionId === p.sessionId) return
      useGroupChatStore.getState().receiveSessionStart(p.groupId, p.sessionId)
      void store.load(p.groupId, p.sessionId, userId ?? store.currentUserId).catch(() => {
        // Not a member server-side / transient failure — the group's own
        // useBindSession recovers the correct state on next entry.
      })
      if (p.at) store.setStartedAt(p.groupId, p.at)
    }
    socket.on('session:start', handleSessionStart)

    return () => {
      socket.off('session:picks', handlePicks)
      socket.off('session:member_done', handleMemberDone)
      socket.off('vote:update', handleVote)
      socket.off('session:confirmed', handleConfirmed)
      socket.off('session:start', handleSessionStart)
    }
  }, [userId, navigate])
}
