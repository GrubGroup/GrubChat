import { useMemo, useState } from 'react'
import { Navigate, useNavigate } from 'react-router'
import { motion, useReducedMotion } from 'framer-motion'
import type { Session } from '@/types'
import { EASE } from '@/lib/motion'
import { GroupsSidebar } from '@/components/session/GroupsSidebar'
import { GroupMessageRow } from '@/components/session/GroupMessageRow'
import { MessagesLoader } from '@/components/session/MessagesLoader'
import { SessionCard } from '@/components/session/SessionCard'
import { GroupDetailPanel } from '@/components/session/GroupDetailPanel'
import { HostSessionModal } from '@/components/session/HostSessionModal'
import { Icon, IconButton } from '@/components/ui'
import { AppSplash } from '@/components/layout/AppSplash'
import { COLUMN_HEADER_H } from '@/components/layout/AppSidebar'
import { MobileActionSheet } from '@/components/layout/MobileActionSheet'
import { MobileHeader } from '@/components/layout/MobileHeader'
import { VoiceComposer } from '@/components/voice/VoiceComposer'
import { TypingIndicator } from '@/components/session/TypingIndicator'
import { cn } from '@/utils/cn'
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
import { useGroupsStore } from '@/stores/groupsStore'
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

  // Where the session card actually sits in the transcript. It must land at the
  // point the session STARTED — after the messages that predate it, before those
  // that follow. We derive that split from the session's start timestamp vs each
  // message's `at`, NOT from the raw message-count the store captured when
  // session:start arrived: on a reload / late-join the session:start echo (or the
  // useBindSession rebind) can run BEFORE the async chat:history backlog lands, so
  // the captured count is 0 and the card gets pinned to the TOP of the chat. That's
  // the "session card randomly jumps to the top" bug — it shows up on the deployed
  // site (real network latency reorders the two async loads) but not on localhost
  // (mock mode has no socket; local latency is ~0). A timestamp split is recomputed
  // after history replaces the list, so it's reload-safe. sessionStartIndex stays
  // the "a session card should show" marker (null vs set) below; only its numeric
  // value was unreliable.
  const sessionSplitIndex = useMemo(() => {
    if (sessionStartIndex === null) return null
    const startMs = startedAt ? Date.parse(startedAt) : NaN
    // startedAt not loaded yet (a brief window on cold entry): keep the card at the
    // BOTTOM (all messages above it) until it arrives — never the top. It snaps into
    // its real position the moment the session loads.
    if (Number.isNaN(startMs)) return messages.length
    const i = messages.findIndex((m) => Date.parse(m.at) >= startMs)
    return i === -1 ? messages.length : i
  }, [sessionStartIndex, startedAt, messages])

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
  // Mobile-only chrome: the ⋯ header overflow. Below `md` the two desktop header
  // buttons don't fit beside the title, so both move behind it.
  const [overflowOpen, setOverflowOpen] = useState(false)

  // Reload survival: rebind the group's in-progress session, which the socket's
  // session:start announced before this page existed. Gated on membership so we
  // never probe a room the user isn't in.
  useBindSession(groupId, isMember)

  // History loads async over the socket (chat:history) after joining. Show a
  // loader until it arrives.
  const loadingHistory = isMember && groupId > 0 && !historyLoaded

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

  // Was the session's host handed off (the original host deleted their account)?
  // session.host_user_id is repointed on hand-off, so it can no longer name the
  // ORIGINAL starter. The durable signal is the persisted "… is now the session
  // host" SYSTEM line — it replays on reload via chat:history and arrives live via
  // chat:message. When present, the "started a session" divider goes neutral rather
  // than mis-attributing the start to the member who merely inherited the host role.
  const hostHandedOff = messages.some(
    (m) => m.type === 'system' && m.text.endsWith(' is now the session host'),
  )

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

  // After leaving, return to the groups page. We deliberately DON'T jump straight
  // into a neighbor group's chat here: the store's list refresh has already
  // dropped this group, which fires the membership guard below (`<Navigate
  // to="/groups">`). Racing that with an imperative navigate to a *different*
  // chat could strand the user on a room whose history loader never resolves —
  // the "keeps loading, won't go back" bug. Sending both to /groups makes the
  // redirect deterministic; on desktop GroupsIndex forwards to the latest group
  // the user still belongs to, which loads through the normal join path.
  const handleLeft = () => {
    setEditing(false)
    navigate('/groups')
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
    <div className="flex h-dvh overflow-hidden bg-surface-raised">
      <GroupsSidebar />

      {/* Chat area — min-w-0 so a long message can't push this flex child past the
          viewport (which would scroll the whole page sideways at 390px). */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* MOBILE header (<md): the chat is a PUSHED screen — its back chevron pops
            up to the groups list (WhatsApp-style), which is also where the Groups
            tab goes. "Start session" and "Edit group" move into the ⋯ overflow,
            since neither fits beside the name at 390px. The avatar stack drops —
            the member count in the subtitle carries the same information. */}
        <MobileHeader
          className="md:hidden"
          onBack={() => navigate('/groups')}
          title={groupName}
          subtitle={
            <>
              {memberCount} members
              {sessionStartIndex !== null && !isComplete && (
                <> · <span className="text-primary-text">session active</span></>
              )}
            </>
          }
          actions={
            <IconButton
              label="More options"
              size="md"
              icon={<Icon name="dots" size={20} />}
              onClick={() => setOverflowOpen(true)}
            />
          }
        />

        {/* DESKTOP header (≥md) — hidden below md, where the MobileHeader takes over;
            same height as the sidebar/right-panel headers for seamless borders. */}
        <div className={cn('hidden items-center justify-between gap-3 border-b border-border px-5 md:flex', COLUMN_HEADER_H)}>
          {/* min-w-0 lets this flex child shrink below its content width so the
              name can truncate (instead of forcing the buttons to wrap) when the
              Edit-group panel opens and narrows the chat column. */}
          <div className="flex min-w-0 items-center gap-3">
            {/* Same rounded emoji badge as the group's sidebar row, so the header
                matches the chat's list image — larger here, with the name + member
                count stacked beside it. */}
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[13px] border border-border bg-surface-raised text-text-muted">
              <Icon name="message" size={20} />
            </span>
            <div className="flex min-w-0 flex-col">
              <span className="truncate font-display text-item-title font-bold text-text">{groupName}</span>
              <p className="truncate text-caption text-text-muted">
                {memberCount} members
                {/* "Session active" only while a live session is in progress — not
                    before one starts, and not once it's complete. */}
                {sessionStartIndex !== null && !isComplete && sessionObj?.closed_at == null && (
                  <> · <span className="text-primary-text">session active</span></>
                )}
              </p>
            </div>
          </div>
          {/* shrink-0 keeps the actions at their natural width; whitespace-nowrap on
              each button stops its label wrapping to two lines when space is tight. */}
          <div className="flex shrink-0 items-center gap-2">
            {/* Start session stays PRESENT the whole time — it's only DISABLED
                while a session is actively running (started but not yet complete),
                and re-enables once results land / the session closes so the group
                can start another. Edit group is anchored to the far right. */}
            <button
              onClick={() => setHostModalOpen(true)}
              disabled={sessionOngoing}
              title={sessionOngoing ? 'A session is already in progress' : undefined}
              className="flex items-center gap-1.5 whitespace-nowrap rounded-input border border-border-strong bg-surface-inverse px-3 py-1.5 text-caption font-medium text-on-inverse dark:bg-surface-sunken dark:text-text dark:hover:bg-surface-panel disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Icon name="sparkles" size={12} /> Start session
            </button>
            <button
              onClick={() => setEditing(true)}
              className="flex items-center gap-1.5 whitespace-nowrap rounded-input border border-border-strong bg-surface-sunken px-3 py-1.5 text-caption font-medium text-text hover:bg-surface-panel"
            >
              <Icon name="users" size={12} /> Edit group
            </button>
          </div>
        </div>

        {/* Messages — min-h-0 so this is the element that scrolls, rather than the
            column growing and pushing the composer below the viewport. */}
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 md:p-5">
          {loadingHistory ? (
            <div className="flex flex-1 flex-col items-center justify-center px-2">
              <MessagesLoader />
            </div>
          ) : (
          <>
          {/* Messages that existed before the session started */}
          {(sessionSplitIndex === null ? messages : messages.slice(0, sessionSplitIndex)).map((m) => (
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
                  {hostHandedOff
                    ? 'Session in progress'
                    : `${nameForMember(sessionObj?.host_user_id ?? 0, members)} started a session`}
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
              {messages.slice(sessionSplitIndex ?? messages.length).map((m) => (
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

      {/* MOBILE (<md) ⋯ overflow — the two desktop header buttons as full-width
          rows. "Start session" keeps its disabled-while-running semantics, with the
          desktop tooltip's text as a visible note. */}
      <MobileActionSheet
        open={overflowOpen}
        onClose={() => setOverflowOpen(false)}
        title={groupName}
        items={[
          {
            icon: 'sparkles',
            label: 'Start session',
            onSelect: () => setHostModalOpen(true),
            disabled: sessionOngoing,
            note: sessionOngoing ? 'A session is already in progress' : undefined,
          },
          { icon: 'users', label: 'Edit group', onSelect: () => setEditing(true) },
        ]}
      />
    </div>
  )
}
