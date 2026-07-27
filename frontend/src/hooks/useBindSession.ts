import { useEffect, useState } from 'react'
import { fetchCurrentGroupSession } from '@/api/groupsApi'
import { useAuthStore } from '@/stores/authStore'
import { useSessionStore, selectActiveSessionId } from '@/stores/sessionStore'
import { useGroupChatStore } from '@/stores/groupChatStore'

/** How far along the attempt to bind this group's live session has got. */
export type SessionBinding =
  | 'idle' // not attempted yet (caller isn't ready — e.g. group list still loading)
  | 'resolving' // asking the gateway whether this group has an open session
  | 'bound' // a session is in the store and ready to drive the UI
  | 'none' // the group has no open session (or the lookup failed)

// Binds a group's in-progress session into the session store, so any session screen
// works on a COLD entry — a refresh or a pasted /groups/:groupId/session/:sessionId
// link. The socket's `session:start` fired before the page existed and isn't
// replayed on join, so without this an in-progress session would simply vanish.
//
// Reuses the same load()/loadRecommendation() calls the socket path uses, plus
// receiveSessionStart so the inline card renders in the group chat. Keyed on
// activeSessionId: once bound it won't re-fetch, so this is a no-op on the common
// path where the socket already delivered the session.
//
// Session state is keyed by GROUP (a group has at most one open session), which is
// why this takes a groupId and not a sessionId — callers validate the URL's
// sessionId against the bound one rather than fetching by it.
export function useBindSession(groupId: number, enabled = true): SessionBinding {
  const activeSessionId = useSessionStore(selectActiveSessionId(groupId))
  const loadSession = useSessionStore((s) => s.load)
  const loadRecommendation = useSessionStore((s) => s.loadRecommendation)
  const receiveSessionStart = useGroupChatStore((s) => s.receiveSessionStart)
  const currentUserId = useAuthStore((s) => s.user?.id ?? 0)
  // "Nothing to bind" records WHICH GROUP it applies to rather than a bare boolean,
  // so the verdict is scoped and the render path stays pure — switching groups
  // invalidates it for free, with no synchronous reset in the effect body.
  const [emptyForGroup, setEmptyForGroup] = useState<number | null>(null)

  useEffect(() => {
    if (!enabled || activeSessionId != null) return
    let cancelled = false
    void (async () => {
      let session
      try {
        session = await fetchCurrentGroupSession(groupId)
      } catch {
        // Lookup failed (offline, or not a member server-side). Treat it as "no
        // session" so the caller redirects rather than hanging on a spinner.
        if (!cancelled) setEmptyForGroup(groupId)
        return
      }
      if (cancelled) return
      if (session == null) {
        setEmptyForGroup(groupId)
        return
      }
      await loadSession(groupId, session.id, currentUserId)
      receiveSessionStart(groupId, session.id)
      void loadRecommendation(groupId)
    })()
    return () => {
      cancelled = true
    }
  }, [
    enabled,
    activeSessionId,
    groupId,
    currentUserId,
    loadSession,
    loadRecommendation,
    receiveSessionStart,
  ])

  // A bound session wins outright, so the empty verdict is only ever consulted when
  // nothing is bound for this group.
  if (activeSessionId != null) return 'bound'
  if (!enabled) return 'idle'
  // Narrow edge case: leaving a group known to be empty and coming back reports
  // 'none' immediately while the fresh lookup runs. If a session started meanwhile,
  // the caller redirects to the group chat, whose own binding then picks it up — one
  // extra hop, never a wrong screen.
  return emptyForGroup === groupId ? 'none' : 'resolving'
}
