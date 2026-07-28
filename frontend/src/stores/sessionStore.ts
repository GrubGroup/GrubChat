import { create } from 'zustand'
import type { Recommendation, Session, SessionMember, SessionPhase } from '@/types'
import { fetchRecommendation, fetchSession, generateRecommendation } from '@/api/sessionApi'
import { useAuthStore } from '@/stores/authStore'
import { getSocket } from '@/lib/socket'

// Which groups have a host-expiry generation in flight — keyed by groupId so two
// groups' timers can each generate independently (a single module boolean would
// latch after the first group and block the second). A groupId stays in the set
// on success (once generated, don't regenerate) and is removed on failure so a
// retry can run. Mirrors the old `let expiryGenerating = false`, per group.
const expiryGenerating = new Set<number>()

// The signed-in user's name fields, so locally-built roster rows for the current
// user carry a real name (the gateway's create response doesn't include one, and
// join/progress rows would otherwise be nameless → "User N"/"U1" avatars).
// Read lazily via getState() — authStore does not import sessionStore, so there's
// no cycle. Returns undefined name fields when signed out (mock defaults apply).
function selfNameFields(userId: number): Pick<SessionMember, 'display_name' | 'username'> {
  const user = useAuthStore.getState().user
  if (!user || user.id !== userId) return {}
  return { display_name: user.display_name ?? null, username: user.username ?? null }
}

// The per-group session slice — everything that used to be a flat field on the
// singleton store, MINUS currentUserId (which is the signed-in identity, not
// per-session, and stays on the store root). Sessions are keyed by group so two
// groups' sessions coexist: starting one in group B no longer overwrites group A's,
// and switching back to A restores A's own progress/roster/results. Mirrors the
// keyed pattern already used by groupChatStore (messagesByGroup, etc.).
export interface SessionSlice {
  session: Session | null
  // The live session id the flow is operating on (host-created or joined). Drives
  // every session REST call (analyze / ready / generate / close). Null until a
  // session is created or loaded.
  activeSessionId: number | null
  // ISO time the countdown started from — the session:start broadcast `at` (live)
  // or the session's created_at. The timer counts time_limit minutes from here.
  startedAt: string | null
  members: SessionMember[]
  // Server-authoritative member count from the session:member_done broadcast.
  // The progress denominator uses max(this, members.length) so a broadcast that
  // arrives before (or without) a full roster load still shows the right total
  // (e.g. 1/6, not 1/1). 0 = unknown → fall back to members.length.
  serverTotal: number
  recommendation: Recommendation | null
  // Results-fetch UI state so the results screen can tell loading / empty / error
  // apart instead of a single permanent "Loading picks…". `recommendationError`
  // is set when the read-back fails on a session that should already have results.
  recommendationLoading: boolean
  recommendationError: boolean
  // True once the session is finalizing (the host force-finished, or the timer
  // expired) — set from a session:member_done{allDone:true} broadcast so EVERY
  // member's card flips to complete immediately, before the recommendation (which
  // takes 10–60s to generate) exists. Distinct from `recommendation != null`, which
  // is the later "results are ready" signal. Cleared on a fresh session.
  sessionFinalizing: boolean
  phase: SessionPhase
  votes: Record<number, number[]> // restaurantId -> userIds who voted
  chosenRestaurantId: number | null
}

// Fresh, independent slice for a group that has no session yet.
const makeSlice = (): SessionSlice => ({
  session: null,
  activeSessionId: null,
  startedAt: null,
  members: [],
  serverTotal: 0,
  recommendation: null,
  recommendationLoading: false,
  recommendationError: false,
  sessionFinalizing: false,
  phase: 'joining',
  votes: {},
  chosenRestaurantId: null,
})

// Stable frozen reference returned by selectors for a group with no slice yet, so
// a selector never yields a fresh object each render (which would loop under React
// 19 StrictMode). Mirrors groupChatStore's `const EMPTY: GroupMessage[] = []`.
const EMPTY_SLICE: SessionSlice = Object.freeze(makeSlice())

interface SessionState {
  byGroup: Record<number, SessionSlice>
  // GLOBAL signed-in identity (not per-session). Set from the auth store by
  // load()/setSession(); read as a top-level field by GroupProgressPanel.
  currentUserId: number

  // Every action takes the target `groupId` first and mutates only that group's
  // slice. Async actions write their target slice UNCONDITIONALLY when they resolve
  // — a late load landing in group A's slice while the user views B is correct now
  // (it keeps A right for when they return), not a leak.
  load: (groupId: number, sessionId: number, currentUserId: number) => Promise<void>
  // Merge the gateway's name-carrying roster into `members` WITHOUT resetting
  // phase/startedAt (unlike load). Used to give the host real member names right
  // after they create a session (their local rows are otherwise nameless).
  hydrateMembers: (groupId: number, sessionId: number) => Promise<void>
  // Adopt a session object directly (e.g. the one the host just created via the
  // modal), without a round-trip. Seeds activeSessionId + startedAt.
  setSession: (groupId: number, session: Session, currentUserId?: number) => void
  // Record when the countdown clock started (from the session:start broadcast).
  setStartedAt: (groupId: number, at: string) => void
  setPhase: (groupId: number, phase: SessionPhase) => void
  join: (groupId: number) => void
  setMemberDone: (groupId: number, userId: number) => void
  // Apply a live session:member_done broadcast: flip that member's status (adding
  // them if the roster hasn't loaded them yet) so every client's progress bar and
  // roster reconcile from the server echo — not an optimistic local flip.
  applyProgress: (
    groupId: number,
    doneCount: number,
    total: number,
    userId: number,
    status: boolean,
    // When true (the session:member_done{allDone} flag), the WHOLE session is done —
    // flip every roster member and set sessionFinalizing so the card completes now.
    allDone?: boolean,
  ) => void
  // Adopt a recommendation delivered live over the socket (session:picks), so the
  // "Results" affordance appears without a fetch. Stores the recommendation only —
  // it deliberately does NOT set phase:'picks' (that implies the user is VIEWING
  // results); navigation to the results screen stays user-driven.
  receivePicks: (
    groupId: number,
    payload: {
      recommendationId: number
      sessionId: number
      items: Recommendation['items']
    },
  ) => void
  loadRecommendation: (groupId: number) => Promise<void>
  // Timer-expiry fallback: the HOST client alone generates results (force_partial)
  // if the countdown runs out before everyone finishes. No-op for non-hosts or
  // when results already exist. Guarded (per group) against concurrent/repeat calls.
  triggerExpiryGeneration: (groupId: number) => Promise<void>
  // Host "Force finish": end the session early over the answers gathered SO FAR
  // (force_partial) — before everyone clicks "I'm Finished" or the timer expires.
  // Same server operation as the expiry fallback (marks remaining members done,
  // generates, broadcasts session:picks); host-only and guarded per group.
  forceFinish: (groupId: number) => Promise<void>
  // Cast the current user's vote for a restaurant on the results page. Emit-only:
  // the server echoes vote:update back to every member (incl. the sender) and
  // receiveVote applies it — single source of truth, no local double-toggle. Falls
  // back to a local apply in mock mode (no socket). Ephemeral / never persisted.
  castVote: (groupId: number, restaurantId: number) => void
  // Apply a live vote:update echo: single-choice toggle for `userId`. The voter id
  // comes from the socket payload (the gateway's authenticated identity), not local.
  receiveVote: (groupId: number, restaurantId: number, userId: number) => void
  chooseRestaurant: (groupId: number, restaurantId: number) => void
  close: (groupId: number) => void
}

export const useSessionStore = create<SessionState>((set, get) => {
  // Read a group's slice (never mutate through this). Falls back to the frozen
  // EMPTY_SLICE so callers always get a full shape.
  const slice = (groupId: number): SessionSlice => get().byGroup[groupId] ?? EMPTY_SLICE

  // Immutably patch ONE group's slice, leaving every other group untouched. The
  // updater receives the current slice, lazily seeded from a fresh makeSlice() if
  // this group has none yet (never the frozen EMPTY_SLICE) — so a group's FIRST
  // write can be an event action (applyProgress, setStartedAt, …) without crashing.
  const patch = (
    groupId: number,
    patchOrFn: Partial<SessionSlice> | ((prev: SessionSlice) => Partial<SessionSlice>),
  ) =>
    set((s) => {
      const prev = s.byGroup[groupId] ?? makeSlice()
      const next = typeof patchOrFn === 'function' ? patchOrFn(prev) : patchOrFn
      return { byGroup: { ...s.byGroup, [groupId]: { ...prev, ...next } } }
    })

  return {
    byGroup: {},
    currentUserId: 1,

    load: async (groupId, sessionId, currentUserId) => {
      const { session, members } = await fetchSession(sessionId)
      // Write unconditionally into THIS group's slice: even if the user has since
      // switched away, the data belongs to `groupId` and keeps it correct for when
      // they return. Keeping currentUserId global (identity, not per-session).
      set({ currentUserId })
      patch(groupId, {
        session,
        members,
        serverTotal: members.length,
        activeSessionId: session.id,
        startedAt: session.created_at ?? null,
        phase: 'joining',
        // A freshly-loaded session must never inherit prior results/votes.
        recommendation: null,
        recommendationLoading: false,
        recommendationError: false,
        sessionFinalizing: false,
        votes: {},
        chosenRestaurantId: null,
      })
    },

    hydrateMembers: async (groupId, sessionId) => {
      const { members: fetched } = await fetchSession(sessionId)
      patch(groupId, (prev) => {
        // Merge fetched name/status rows over the local roster, preserving any
        // local status flip that's newer than the fetch (a member who finished
        // between create and hydrate). Fetched rows are the source of names.
        const byId = new Map(prev.members.map((m) => [m.user_id, m]))
        const merged = fetched.map((f) => {
          const local = byId.get(f.user_id)
          return { ...f, status: local?.status || f.status }
        })
        // Keep any local-only rows the fetch doesn't know about yet.
        for (const local of prev.members) {
          if (!merged.some((m) => m.user_id === local.user_id)) merged.push(local)
        }
        return { members: merged, serverTotal: Math.max(prev.serverTotal, merged.length) }
      })
    },

    setSession: (groupId, session, currentUserId) => {
      const uid = currentUserId ?? get().currentUserId
      // Keep the global identity fresh when the caller supplied it.
      if (currentUserId != null) set({ currentUserId })
      // A brand-new session clears this group's once-per-session expiry-generation
      // latch, so the new session's timer fallback can fire (a prior session in the
      // same group may have set it).
      expiryGenerating.delete(groupId)
      patch(groupId, () => {
        // Adopting a session the current user just created is a FRESH START — even
        // if a prior session ran in this group. Seed the roster with ONLY the host
        // (their real name); hydrateMembers merges in the rest. Do NOT carry over
        // the previous session's roster/total, results, or voting — otherwise the
        // new session's card could show an instant 'complete' from a stale
        // recommendation. Guards the "start another session after one completes" flow.
        const members = [
          {
            session_id: session.id,
            user_id: uid,
            status: false,
            joined_at: new Date().toISOString(),
            ...selfNameFields(uid),
          },
        ]
        return {
          session,
          members,
          serverTotal: members.length,
          activeSessionId: session.id,
          startedAt: session.created_at ?? new Date().toISOString(),
          phase: 'joining',
          recommendation: null,
          recommendationLoading: false,
          recommendationError: false,
          sessionFinalizing: false,
          votes: {},
          chosenRestaurantId: null,
        }
      })
    },

    setStartedAt: (groupId, at) => patch(groupId, { startedAt: at }),

    setPhase: (groupId, phase) => patch(groupId, { phase }),

    join: (groupId) => {
      const uid = get().currentUserId
      patch(groupId, (prev) => {
        const already = prev.members.some((m) => m.user_id === uid)
        const members = already
          ? prev.members
          : [
              ...prev.members,
              {
                session_id: prev.session?.id ?? 0,
                user_id: uid,
                status: false,
                joined_at: new Date().toISOString(),
                ...selfNameFields(uid),
              },
            ]
        return { members, phase: 'waiting' }
      })
    },

    setMemberDone: (groupId, userId) =>
      patch(groupId, (prev) => ({
        members: prev.members.map((m) => (m.user_id === userId ? { ...m, status: true } : m)),
        // If it was the current user, advance their UI phase to "done".
        ...(userId === get().currentUserId ? { phase: 'done' as const } : {}),
      })),

    applyProgress: (groupId, _doneCount, total, userId, status, allDone = false) =>
      patch(groupId, (prev) => {
        const known = prev.members.some((m) => m.user_id === userId)
        const upserted = known
          ? prev.members.map((m) =>
              m.user_id === userId
                ? // Backfill the current user's name if this row was created bare
                  // (e.g. by an earlier progress echo) so its avatar isn't "User N".
                  { ...m, status, ...(m.display_name || m.username ? {} : selfNameFields(userId)) }
                : m,
            )
          : [
              ...prev.members,
              {
                session_id: prev.session?.id ?? prev.activeSessionId ?? 0,
                user_id: userId,
                status,
                joined_at: new Date().toISOString(),
                ...selfNameFields(userId),
              },
            ]
        // On an allDone broadcast (host force-finish / timer expiry) the WHOLE session
        // is done — flip every member so this client's `doneCount === total` and the
        // card completes immediately, not just the one user in the payload.
        const members = allDone ? upserted.map((m) => ({ ...m, status: true })) : upserted
        return {
          members,
          // Trust the server's authoritative total so the denominator is right even
          // if this client's roster load hasn't landed (or was missed on reload).
          serverTotal: Math.max(total, members.length, prev.serverTotal),
          // allDone marks the session as finalizing so the card flips to complete even
          // before the recommendation (10–60s away) lands — the shared loading state.
          ...(allDone ? { sessionFinalizing: true } : {}),
          // Reflect the current user's own completion in their local UI phase.
          ...((allDone || (userId === get().currentUserId && status))
            ? { phase: 'done' as const }
            : {}),
        }
      }),

    receivePicks: (groupId, { recommendationId, sessionId, items }) =>
      patch(groupId, {
        recommendation: {
          id: recommendationId,
          session_id: sessionId,
          created_at: new Date().toISOString(),
          items,
        },
      }),

    loadRecommendation: async (groupId) => {
      const id = slice(groupId).activeSessionId ?? slice(groupId).session?.id
      if (id == null) return
      patch(groupId, { recommendationLoading: true, recommendationError: false })

      // Results often don't exist the instant the user opens the picks screen — the
      // group orchestrator can still be running (the read-back 404s), or we're
      // waiting on the last member to finish. Rather than flashing an alarming
      // "Couldn't load results" error, keep the loading circle up and POLL for a
      // while. A live session:picks delivery (receivePicks) can populate this
      // group's recommendation meanwhile, which ends the poll early. Only after
      // we've exhausted our patience do we surface a retryable error.
      const MAX_ATTEMPTS = 20
      const RETRY_MS = 3000
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        // A socket delivery may already have filled this group's recommendation.
        if (slice(groupId).recommendation) {
          patch(groupId, { recommendationLoading: false, recommendationError: false })
          return
        }
        try {
          const recommendation = await fetchRecommendation(id)
          patch(groupId, {
            recommendation,
            phase: 'picks',
            recommendationLoading: false,
            recommendationError: false,
          })
          return
        } catch {
          // Not ready yet (usually a 404 while generation runs). Wait, then retry —
          // keeping the loading state up so the UI never shows an error mid-flight.
          if (attempt < MAX_ATTEMPTS - 1) {
            await new Promise((resolve) => setTimeout(resolve, RETRY_MS))
          }
        }
      }
      // Gave up after repeated attempts — surface a retryable error state (the user
      // can hit Retry, and a later session:picks socket delivery still recovers it).
      patch(groupId, { recommendationLoading: false, recommendationError: true })
    },

    triggerExpiryGeneration: async (groupId) => {
      const sl = slice(groupId)
      const isHost = sl.session != null && sl.session.host_user_id === get().currentUserId
      // Only the host generates; skip if results already exist or none in progress.
      if (sl.activeSessionId == null || sl.recommendation != null || !isHost) return
      if (expiryGenerating.has(groupId)) return
      expiryGenerating.add(groupId)
      try {
        await generateRecommendation(sl.activeSessionId, { forcePartial: true })
        // The gateway broadcasts session:picks, so results arrive via the socket.
      } catch {
        // Generation failure (e.g. 409 not-ready) is surfaced elsewhere; release the
        // per-group guard so a later retry rather than latching it.
        expiryGenerating.delete(groupId)
      }
    },

    forceFinish: async (groupId) => {
      const sl = slice(groupId)
      const isHost = sl.session != null && sl.session.host_user_id === get().currentUserId
      // Host-only; skip if there's no session or results already exist. Reuses the
      // same per-group latch as the timer fallback so the two can't double-fire.
      if (sl.activeSessionId == null || sl.recommendation != null || !isHost) return
      if (expiryGenerating.has(groupId)) return
      expiryGenerating.add(groupId)
      // Mark this group's results as loading AND the session as finalizing right away.
      // sessionFinalizing flips the group-chat card to "complete" (Results) for the
      // host IMMEDIATELY — so force-finish is a one-time action: if the host backs out
      // of the loading screen, the card shows the results state, not another
      // "Force finish" button. It doesn't depend on the session:member_done broadcast
      // (which the host may miss after leaving the group room to view picks).
      patch(groupId, {
        recommendationLoading: true,
        recommendationError: false,
        sessionFinalizing: true,
      })
      try {
        // force_partial: the gateway marks any un-finished members done, generates
        // over whatever answers exist, and broadcasts session:picks. We ALSO adopt
        // the recommendation it returns directly, so the results screen renders
        // ready content the moment we navigate — no wait on the socket echo/poll.
        const recommendation = await generateRecommendation(sl.activeSessionId, {
          forcePartial: true,
        })
        patch(groupId, {
          recommendation,
          recommendationLoading: false,
          recommendationError: false,
        })
      } catch {
        // Release the guard on failure so the host can retry (or the timer can), clear
        // the loading flag, and revert the finalizing flag so the card returns to its
        // in-progress state and the host can force-finish again.
        expiryGenerating.delete(groupId)
        patch(groupId, { recommendationLoading: false, sessionFinalizing: false })
        throw new Error('force-finish failed')
      }
    },

    castVote: (groupId, restaurantId) => {
      const socket = getSocket()
      if (socket) {
        // Fire-and-forget: the vote applies when the server echoes vote:update back
        // (single source of truth — no local/echo double-toggle). The server injects
        // the authoritative voter id from the authenticated socket.
        socket.emit('vote:cast', { groupId, restaurantId })
      } else {
        // Mock mode (no socket): apply locally so the demo still toggles.
        get().receiveVote(groupId, restaurantId, get().currentUserId)
      }
    },

    receiveVote: (groupId, restaurantId, userId) =>
      patch(groupId, (prev) => {
        const next: Record<number, number[]> = {}
        // A user has at most one vote — remove them from all lists first.
        for (const [rid, voters] of Object.entries(prev.votes)) {
          next[Number(rid)] = voters.filter((u) => u !== userId)
        }
        const current = next[restaurantId] ?? []
        // Toggle: casting for your current pick removes the vote.
        const already = (prev.votes[restaurantId] ?? []).includes(userId)
        next[restaurantId] = already ? current : [...current, userId]
        return { votes: next }
      }),

    chooseRestaurant: (groupId, restaurantId) => patch(groupId, { chosenRestaurantId: restaurantId }),

    close: (groupId) =>
      patch(groupId, (prev) => ({
        phase: 'complete',
        session: prev.session ? { ...prev.session, closed_at: new Date().toISOString() } : null,
      })),
  }
})

// Field selectors — one per field a component reads, each parameterized by group
// and returning a primitive or the slice's own (stable-until-mutated) reference via
// EMPTY_SLICE, so absent-group reads never allocate a fresh value (StrictMode-safe).
// Mirrors groupChatStore's selectGroupMessages(groupId) => (s) => … helpers.
export const selectSlice = (groupId: number) => (s: SessionState) =>
  s.byGroup[groupId] ?? EMPTY_SLICE
export const selectSession = (groupId: number) => (s: SessionState) =>
  (s.byGroup[groupId] ?? EMPTY_SLICE).session
export const selectActiveSessionId = (groupId: number) => (s: SessionState) =>
  (s.byGroup[groupId] ?? EMPTY_SLICE).activeSessionId
export const selectStartedAt = (groupId: number) => (s: SessionState) =>
  (s.byGroup[groupId] ?? EMPTY_SLICE).startedAt
export const selectMembers = (groupId: number) => (s: SessionState) =>
  (s.byGroup[groupId] ?? EMPTY_SLICE).members
export const selectPhase = (groupId: number) => (s: SessionState) =>
  (s.byGroup[groupId] ?? EMPTY_SLICE).phase
export const selectRecommendation = (groupId: number) => (s: SessionState) =>
  (s.byGroup[groupId] ?? EMPTY_SLICE).recommendation
export const selectRecommendationLoading = (groupId: number) => (s: SessionState) =>
  (s.byGroup[groupId] ?? EMPTY_SLICE).recommendationLoading
export const selectRecommendationError = (groupId: number) => (s: SessionState) =>
  (s.byGroup[groupId] ?? EMPTY_SLICE).recommendationError
export const selectSessionFinalizing = (groupId: number) => (s: SessionState) =>
  (s.byGroup[groupId] ?? EMPTY_SLICE).sessionFinalizing
export const selectVotes = (groupId: number) => (s: SessionState) =>
  (s.byGroup[groupId] ?? EMPTY_SLICE).votes

// Derived selectors — replace the old zero-arg store methods. All return primitives
// (number/boolean), so referential stability is a non-issue.
export const selectDoneCount = (groupId: number) => (s: SessionState) =>
  (s.byGroup[groupId] ?? EMPTY_SLICE).members.filter((m) => m.status).length
export const selectProgressTotal = (groupId: number) => (s: SessionState) => {
  const sl = s.byGroup[groupId] ?? EMPTY_SLICE
  return Math.max(sl.serverTotal, sl.members.length)
}
export const selectIsHost = (groupId: number) => (s: SessionState) => {
  const sl = s.byGroup[groupId] ?? EMPTY_SLICE
  return sl.session != null && sl.session.host_user_id === s.currentUserId
}
