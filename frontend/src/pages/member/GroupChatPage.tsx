import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import type { Session } from '@/types'
import { EASE } from '@/lib/motion'
import { GroupsSidebar } from '@/components/session/GroupsSidebar'
import { GroupMessageRow } from '@/components/session/GroupMessageRow'
import { SessionCard } from '@/components/session/SessionCard'
import { GroupDetailPanel } from '@/components/session/GroupDetailPanel'
import { HostSessionModal } from '@/components/session/HostSessionModal'
import { Avatar, Icon, Spinner } from '@/components/ui'
import { AppSplash } from '@/components/layout/AppSplash'
import { COLUMN_HEADER_H } from '@/components/layout/AppSidebar'
import { VoiceComposer } from '@/components/voice/VoiceComposer'
import { TypingIndicator } from '@/components/session/TypingIndicator'
import { cn } from '@/utils/cn'
import { memberColor } from '@/constants/memberColors'
import { nameForMember } from '@/utils/memberName'
import { toSlugId } from '@/utils/slug'
import {
  useSessionStore,
  selectMembers,
  selectDoneCount,
  selectProgressTotal,
  selectSession,
  selectActiveSessionId,
  selectRecommendation,
  selectPhase,
  selectStartedAt,
  selectIsHost,
  selectSessionFinalizing,
} from '@/stores/sessionStore'
import { useAuthStore } from '@/stores/authStore'
import { useGroupId } from '@/hooks/useGroupId'
import { useGroupsStore, mostRecentGroup } from '@/stores/groupsStore'
import {
  useGroupChatStore,
  selectGroupMessages,
  selectHistoryLoaded,
  selectSessionStartIndex,
  selectTypers,
} from '@/stores/groupChatStore'
import { useBindSession } from '@/hooks/useBindSession'
import { useSocket } from '@/hooks/useSocket'
import { useSessionCountdown } from '@/hooks/useSessionCountdown'
import { useScrollToBottom } from '@/hooks/useScrollToBottom'
import { useNewItemIds } from '@/hooks/useNewItemIds'

export function GroupChatPage() {
  const reduce = useReducedMotion()
  const navigate = useNavigate()
  const groupId = useGroupId()
  // Session state is keyed by group — read THIS group's slice via selectors.
  const members = useSessionStore(selectMembers(groupId))
  const doneCount = useSessionStore(selectDoneCount(groupId))
  const progressTotal = useSessionStore(selectProgressTotal(groupId))
  const sessionObj = useSessionStore(selectSession(groupId))
  const activeSessionId = useSessionStore(selectActiveSessionId(groupId))
  const recommendation = useSessionStore(selectRecommendation(groupId))
  const phase = useSessionStore(selectPhase(groupId))
  const join = useSessionStore((s) => s.join)
  const setSession = useSessionStore((s) => s.setSession)
  const hydrateMembers = useSessionStore((s) => s.hydrateMembers)
  const startedAt = useSessionStore(selectStartedAt(groupId))
  const triggerExpiryGeneration = useSessionStore((s) => s.triggerExpiryGeneration)
  const forceFinish = useSessionStore((s) => s.forceFinish)
  const isHost = useSessionStore(selectIsHost(groupId))
  const sessionFinalizing = useSessionStore(selectSessionFinalizing(groupId))
  const currentUserId = useAuthStore((s) => s.user?.id ?? 0)

  // Resolve membership BEFORE connecting the socket, so we never join a room the
  // user isn't in — a group counts only if it's in the loaded list. groupId 0 is
  // the no-group sentinel (see navStore).
  const groups = useGroupsStore((s) => s.groups)
  const groupsLoaded = useGroupsStore((s) => s.loaded)
  const loadGroups = useGroupsStore((s) => s.load)
  const group = groups.find((g) => g.id === groupId)
  const groupName = group?.name ?? 'Group'
  const isMember = groupId > 0 && !!group

  // Live group chat: connect + join the selected room. Only join a room the user
  // actually belongs to — pass 0 otherwise (useSocket skips the join for a
  // non-positive id).
  useSocket(isMember ? groupId : 0)
  const messages = useGroupChatStore(selectGroupMessages(groupId))
  const historyLoaded = useGroupChatStore(selectHistoryLoaded(groupId))
  const sendMessage = useGroupChatStore((s) => s.sendMessage)
  const startSession = useGroupChatStore((s) => s.startSession)
  const clearSessionStart = useGroupChatStore((s) => s.clearSessionStart)
  const setTyping = useGroupChatStore((s) => s.setTyping)
  const typers = useGroupChatStore(selectTypers(groupId))

  // Session-start is synced live via the socket. The store records, per group,
  // the message index where the card belongs (null = not started), so every
  // client shows the card inline at the same point. Broadcasts to the whole room.
  const sessionStartIndex = useGroupChatStore(selectSessionStartIndex(groupId))

  // Auto-scroll to newest. Opening a chat (or switching groups via the groupId
  // reset key, or the initial socket history bulk-load) jumps to the bottom
  // instantly; a single new item (echo lands, +1) smooth-scrolls into view.
  // The count sums EVERY thing that renders in the stream so any new item pushes
  // the view down: chat + system messages (both in `messages`), the typing
  // bubble, and the "started a session" card — which is placed via an index, not
  // a message, so it must be folded in explicitly or a new session wouldn't scroll.
  const endRef = useScrollToBottom<HTMLDivElement>(
    messages.length + typers.length + (sessionStartIndex !== null ? 1 : 0),
    groupId,
  )
  // Only messages that just arrived pop in; opening/switching a group renders the
  // existing history static (keyed by groupId so a switch resets the "seen" set).
  const newIds = useNewItemIds(messages.map((m) => m.id), groupId)

  // Group-detail (edit) panel visibility.
  const [editing, setEditing] = useState(false)
  // Host pre-session setup modal.
  const [hostModalOpen, setHostModalOpen] = useState(false)
  // Host "Force finish" request in flight (disables the card's button).
  const [forcing, setForcing] = useState(false)

  // Reload survival: rebind the group's in-progress session, which the socket's
  // session:start announced before this page existed. Gated on membership so we
  // never probe a room the user isn't in.
  useBindSession(groupId, isMember)

  // History loads async over the socket (chat:history) after joining. Show a
  // loader until it arrives.
  const loadingHistory = isMember && groupId > 0 && !historyLoaded

  const memberIds = members.map((m) => m.user_id)
  const total = progressTotal || members.length || 0

  // The card state is derived entirely from SESSION STATE, so it reflects reality
  // regardless of how the user got here:
  //   complete → results exist / everyone finished / the host already closed the
  //     session. Shows the "Results" button and blocks re-joining (#7, #12).
  //   waiting  → this user finished but the group hasn't. Shows "Waiting for
  //     others" (#6).
  //   else     → nobody's finished yet, so offer Join.
  const allDone = total > 0 && doneCount === total
  // Local countdown: once a running session's timer hits zero, the session is over
  // for everyone regardless of any server broadcast. Folding `expired` into
  // isComplete flips the card to "complete" (Results) immediately on timeout — the
  // server signals (sessionFinalizing/allDone) only arrive after the host generates,
  // so without this a plain timeout left the card stuck on "in progress / Join".
  const { expired } = useSessionCountdown(startedAt, sessionObj?.time_limit ?? 0)
  const timedOut = sessionStartIndex !== null && expired
  // sessionFinalizing: the host force-finished / the timer expired (session:member_done
  // with allDone). Flips the card to complete for EVERY member the instant it arrives —
  // before the recommendation is generated — so no one is left on a stale "in progress /
  // Join" card. `recommendation != null` is the later "results ready" signal.
  const isComplete =
    recommendation != null ||
    allDone ||
    sessionFinalizing ||
    timedOut ||
    sessionObj?.closed_at != null
  const iAmDone =
    phase === 'done' || members.find((m) => m.user_id === currentUserId)?.status === true
  const cardState = isComplete ? 'complete' : iAmDone ? 'waiting' : 'not-joined'

  // A session is "ongoing" once it has started but hasn't completed — the window
  // in which "Start session" is disabled (you can't run two at once). Once
  // complete (or none started), the button is clickable again so the group can
  // kick off another session in the same chat.
  const sessionOngoing = sessionStartIndex !== null && !isComplete && sessionObj?.closed_at == null

  // Header "X members" reflects the real group membership from GET /api/groups
  // (member_count); falls back to the session total when absent.
  const memberCount = group?.member_count ?? total

  // Base path for this group's live session. Null until a session is bound, which
  // is why every session affordance below is guarded — the card can render from a
  // socket echo a beat before activeSessionId lands.
  const sessionPath =
    activeSessionId != null
      ? `/groups/${toSlugId(group?.name, groupId)}/sessions/${activeSessionId}`
      : null

  // Host finished the pre-session modal: adopt the created session locally, then
  // broadcast session:start WITH its id so every member's client can adopt it and
  // share one countdown. The inline card appears via the server echo.
  const handleSessionCreated = (session: Session) => {
    // Clear any PRIOR session's card marker for this group first, so the new
    // session places a fresh card (receiveSessionStart dedupes while a marker
    // exists). setSession clears the prior session's results/roster in the
    // session store. Together these make "start another session" work after one
    // completes — otherwise the new session inherits the old card position and
    // stale picks.
    clearSessionStart(groupId)
    setSession(groupId, session, currentUserId)
    startSession(groupId, session.id)
    // The card appears via the server's session:start echo. The create response
    // has no member names, and the host skips the session:start load() — so fetch
    // the name-carrying roster now, else the host's own avatar/roster shows
    // "User N"/"U1".
    void hydrateMembers(groupId, session.id)
    setHostModalOpen(false)
  }

  const handleJoin = () => {
    if (!sessionPath) return
    join(groupId)
    navigate(sessionPath)
  }

  // Host ends the session early: kick off generation over the answers gathered so
  // far and open the results screen IMMEDIATELY — don't block navigation on the
  // up-to-120s generate POST. forceFinish sets recommendationLoading synchronously,
  // so TopPicks shows its spinner, then fills from whichever lands first: the HTTP
  // adopt (this host), the session:picks socket broadcast (every member, via
  // useSessionSync), or the TopPicks loadRecommendation poll fallback — all
  // idempotent. This is what makes results appear with no wait and no reload.
  const handleForceFinish = () => {
    if (forcing) return
    setForcing(true)
    void forceFinish(groupId)
      .catch(() => {
        // Generation failed to kick off — the socket broadcast / poll fallback on
        // the results screen still recover it; nothing to do here.
      })
      .finally(() => setForcing(false))
    // Navigate without awaiting. sessionPath is non-null whenever the card's
    // force-finish button is reachable (it renders from a bound session), but guard
    // anyway — a missing path leaves the host on the chat rather than routing to
    // `/undefined/picks`.
    if (sessionPath) navigate(`${sessionPath}/picks`)
  }

  // After leaving, the group is gone from the (refreshed) list. Jump to the next
  // most-recent group, or /groups when none remain.
  const handleLeft = () => {
    setEditing(false)
    const next = mostRecentGroup(useGroupsStore.getState().groups)
    navigate(next ? `/groups/${toSlugId(next.name, next.id)}` : '/groups')
  }

  // Bounce a user who isn't a member of the group the URL names — but only once
  // the list has loaded, so an in-flight/empty list doesn't throw a valid member
  // off their own chat. `replace` keeps the bad URL out of the history stack.
  if (groupsLoaded && !isMember) return <Navigate to="/groups" replace />

  // Membership is still unresolved: the list hasn't arrived (a cold URL entry —
  // RequireAuth owns that fetch). Hold the frame with the same branded loader the
  // session check uses, so the two run together seamlessly. This must not render
  // nothing: doing so is what made a reload look like a permanently broken app.
  // "Still loading" and "not your group" are different states, and only the second
  // one above redirects.
  if (!isMember) return <AppSplash />

  return (
    <div className="flex h-screen overflow-hidden bg-surface-raised">
      <GroupsSidebar />

      {/* Chat area */}
      <div className="flex flex-1 flex-col">
        {/* Header — same height as sidebar/right-panel headers for seamless borders */}
        <div className={cn('flex items-center justify-between border-b border-border px-5', COLUMN_HEADER_H)}>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-display text-item-title font-bold text-text">{groupName}</span>
              {/* Overlapping member stack — a newly added member pops into the
                  cluster (spring scale-in) when the roster grows. */}
              <div className="flex -space-x-1.5">
                <AnimatePresence initial={false}>
                  {memberIds.slice(0, 5).map((id) => (
                    <motion.span
                      key={id}
                      layout={!reduce}
                      initial={{ opacity: 0, scale: reduce ? 1 : 0.4 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: reduce ? 1 : 0.4 }}
                      transition={
                        reduce ? { duration: 0.15 } : { type: 'spring', stiffness: 520, damping: 26 }
                      }
                    >
                      <Avatar
                        name={nameForMember(id, members)}
                        size="sm"
                        colorClass={memberColor(id)}
                        className="h-4 w-4 border border-surface-raised text-[7px]"
                      />
                    </motion.span>
                  ))}
                </AnimatePresence>
              </div>
            </div>
            <p className="text-caption text-text-muted">
              {memberCount} members
              {/* "Session active" only while a live session is in progress — not
                  before one starts, and not once it's complete. */}
              {sessionStartIndex !== null && !isComplete && sessionObj?.closed_at == null && (
                <> · <span className="text-primary">session active</span></>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* Start session stays PRESENT the whole time — it's only DISABLED
                while a session is actively running (started but not yet complete),
                and re-enables once results land / the session closes so the group
                can start another. Edit group is anchored to the far right. */}
            <button
              onClick={() => setHostModalOpen(true)}
              disabled={sessionOngoing}
              title={sessionOngoing ? 'A session is already in progress' : undefined}
              className="flex items-center gap-1.5 rounded-input bg-surface-inverse px-3 py-1.5 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Icon name="sparkles" size={12} /> Start session
            </button>
            <button
              onClick={() => setEditing(true)}
              className="flex items-center gap-1.5 rounded-input border border-border px-3 py-1.5 text-caption font-medium text-text hover:bg-surface-sunken"
            >
              <Icon name="users" size={12} /> Edit group
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-5">
          {loadingHistory ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-text-muted">
              <Spinner size="md" />
              <span className="text-caption">Loading messages…</span>
            </div>
          ) : (
          <>
          {/* Messages that existed before the session started */}
          {(sessionStartIndex === null ? messages : messages.slice(0, sessionStartIndex)).map((m) => (
            <GroupMessageRow
              key={m.id}
              message={m}
              currentUserId={currentUserId}
              members={members}
              isNew={newIds.has(m.id)}
            />
          ))}

          {/* Session-started divider + card — inline at the point the user started it.
              Hidden once the session is CLOSED (host confirmed a restaurant): closed_at
              is server truth, so the card + Results access vanish for every member
              regardless of the ephemeral sessionStartIndex marker's state. */}
          {sessionStartIndex !== null && sessionObj?.closed_at == null && (
            <>
              {/* The session announcement rises into the transcript like a message. */}
              <motion.div
                className="flex flex-col gap-3"
                initial={{ opacity: 0, y: reduce ? 0 : 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: reduce ? 0.2 : 0.3, ease: EASE }}
              >
                <div className="flex items-center gap-3 py-1 text-caption text-text-muted">
                  <span className="h-px flex-1 bg-border" />
                  {nameForMember(sessionObj?.host_user_id ?? 0, members)} started a session
                  <span className="h-px flex-1 bg-border" />
                </div>
                <SessionCard
                  state={cardState}
                  members={members}
                  readyCount={cardState === 'complete' ? total : doneCount}
                  total={total}
                  startedAt={startedAt}
                  minutes={sessionObj?.time_limit}
                  onJoin={handleJoin}
                  onContinue={() => sessionPath && navigate(sessionPath)}
                  onViewResults={() => sessionPath && navigate(`${sessionPath}/picks`)}
                  onExpire={() => void triggerExpiryGeneration(groupId)}
                  onReview={() => sessionPath && navigate(`${sessionPath}/done`)}
                  isHost={isHost}
                  onForceFinish={handleForceFinish}
                  forcing={forcing}
                />
              </motion.div>

              {/* Messages that arrived after the session started */}
              {messages.slice(sessionStartIndex).map((m) => (
                <GroupMessageRow
                  key={m.id}
                  message={m}
                  currentUserId={currentUserId}
                  members={members}
                  isNew={newIds.has(m.id)}
                />
              ))}
            </>
          )}
          </>
          )}
          <div ref={endRef} />
        </div>

        {/* Live "… is typing" bubble, pinned just above the composer */}
        <TypingIndicator typers={typers} members={members} />

        {/* Composer — same reusable message bar as the agent chat */}
        <VoiceComposer
          onSend={(text) => sendMessage(groupId, text)}
          onTyping={(isTyping) => setTyping(groupId, isTyping)}
          placeholder="Message"
        />
      </div>

      {/* Group detail / edit panel (slides in from the right) */}
      <GroupDetailPanel
        key={groupId}
        open={editing}
        groupId={groupId}
        currentUserId={currentUserId}
        onClose={() => setEditing(false)}
        onMembersChanged={() => void loadGroups()}
        onLeft={handleLeft}
      />

      {/* Host pre-session setup */}
      <HostSessionModal
        open={hostModalOpen}
        groupId={groupId}
        onClose={() => setHostModalOpen(false)}
        onCreated={handleSessionCreated}
      />
    </div>
  )
}
