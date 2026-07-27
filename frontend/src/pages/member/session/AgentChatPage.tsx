import { useEffect, useState } from 'react'
import { Navigate, useNavigate } from 'react-router'
import { GroupsSidebar } from '@/components/session/GroupsSidebar'
import { ChatStream } from '@/components/session/ChatStream'
import { GroupProgressPanel } from '@/components/session/GroupProgressPanel'
import { NotedSoFarPanel } from '@/components/session/NotedSoFarPanel'
import { SessionTopBar } from '@/components/session/SessionTopBar'
import { VoiceComposer } from '@/components/voice/VoiceComposer'
import { Button, Icon, Spinner } from '@/components/ui'
import { COLUMN_HEADER_H } from '@/components/layout/AppSidebar'
import { cn } from '@/utils/cn'
import {
  useChatStore,
  selectChatMessages,
  selectChatSessionId,
  selectSending,
  selectMissingSignals,
  selectIsComplete,
} from '@/stores/chatStore'
import {
  useSessionStore,
  selectPhase,
  selectDoneCount,
  selectProgressTotal,
  selectRecommendation,
  selectActiveSessionId,
  selectIsHost,
} from '@/stores/sessionStore'
import { useAuthStore } from '@/stores/authStore'
import { useGroupsStore } from '@/stores/groupsStore'
import { toSlugId } from '@/utils/slug'
import { useGroupId } from '@/hooks/useGroupId'
import { useSessionId } from '@/hooks/useSessionId'
import { useBindSession } from '@/hooks/useBindSession'
import { useSocket } from '@/hooks/useSocket'
import { setReady } from '@/api/sessionApi'
import { chipsForMissing } from '@/constants/agentChat'

export interface AgentChatPageProps {
  /** Route-supplied: `…/session/:sessionId/done` renders the finished state, where
   * the transcript stays visible for review and the composer becomes a waiting
   * footer. */
  done?: boolean
}

export function AgentChatPage({ done = false }: AgentChatPageProps) {
  const navigate = useNavigate()
  const groupId = useGroupId()
  const urlSessionId = useSessionId()
  // Readable slug for this group's URLs (`foodie-friends-42`). Falls back to the
  // bare id when the group list hasn't landed — still a valid, resolvable path.
  const groupName = useGroupsStore((s) => s.groups.find((g) => g.id === groupId)?.name)
  const groupSlug = toSlugId(groupName, groupId)
  // Cold entry (refresh or a pasted link) has no session in the store yet — the
  // socket's session:start fired before this page existed. Bind it from the gateway.
  const binding = useBindSession(groupId)

  // Agent-chat transcript + session state are both keyed by group.
  const messages = useChatStore(selectChatMessages(groupId))
  const seed = useChatStore((s) => s.seed)
  const chatSessionId = useChatStore(selectChatSessionId(groupId))
  const sendUserMessage = useChatStore((s) => s.sendUserMessage)
  const adoptSessionId = useChatStore((s) => s.adoptSessionId)
  const sending = useChatStore(selectSending(groupId))
  const missingSignals = useChatStore(selectMissingSignals(groupId))
  const isComplete = useChatStore(selectIsComplete(groupId))

  const phase = useSessionStore(selectPhase(groupId))
  const setPhase = useSessionStore((s) => s.setPhase)
  const setMemberDone = useSessionStore((s) => s.setMemberDone)
  const doneCount = useSessionStore(selectDoneCount(groupId))
  const progressTotal = useSessionStore(selectProgressTotal(groupId))
  const recommendation = useSessionStore(selectRecommendation(groupId))
  const activeSessionId = useSessionStore(selectActiveSessionId(groupId))
  const forceFinish = useSessionStore((s) => s.forceFinish)
  const isHost = useSessionStore(selectIsHost(groupId))
  const currentUserId = useAuthStore((s) => s.user?.id ?? 0)
  const displayName = useAuthStore((s) => s.user?.display_name ?? s.user?.username ?? null)

  // Quick-reply chips follow the question the agent just asked (its first
  // still-missing signal), mirroring interactive_session.py's per-question chips.
  // Before the first turn (nothing asked/missing yet) show the cuisine chips —
  // the opening greeting asks about preferred cuisines first.
  const quickReplies = chipsForMissing(
    missingSignals.length ? missingSignals : ['preferred_cuisines'],
  )

  // "All set": the agent has nothing left to ask. Keyed off the server's
  // authoritative is_complete flag (chatStore.isComplete), which is only true
  // after a real analyze turn — so the opening greeting never falsely reads as
  // complete, and a skipped-but-answered step (empty dislikes) still counts as
  // done. Once true, we surface a gentle "good to go" banner and keep the
  // composer open so corrections are still possible.
  const hasAnswered = messages.some((m) => m.role === 'user')
  const allSet = hasAnswered && isComplete && !sending

  // Keep the live socket subscribed while the member chats, so session:member_done
  // progress + a session:picks delivery still update this page (the group-chat page
  // is unmounted here). The singleton socket makes the room join idempotent.
  useSocket(groupId)

  useEffect(() => {
    // Seed the conversation when there's none yet, or re-seed when it belongs to
    // a GENUINELY DIFFERENT session — so a new session never inherits the prior
    // transcript. Refining an unknown id into the real one (chatSessionId null →
    // activeSessionId concrete) is NOT a session change: adopt the id onto the
    // in-progress transcript instead of re-seeding, so a turn sent during that
    // window is never wiped.
    const isDifferentSession =
      chatSessionId != null && activeSessionId != null && chatSessionId !== activeSessionId
    if (messages.length === 0 || isDifferentSession) {
      seed(groupId, activeSessionId, displayName)
    } else if (chatSessionId == null && activeSessionId != null) {
      adoptSessionId(groupId, activeSessionId)
    }
    if (phase === 'joining' || phase === 'waiting') setPhase(groupId, 'chatting')
  }, [
    groupId,
    displayName,
    messages.length,
    chatSessionId,
    activeSessionId,
    seed,
    adoptSessionId,
    phase,
    setPhase,
  ])

  // The conversation ALWAYS stays visible (matches wireframe). Only the bottom
  // bar changes: composer → done pill, driven by the `/done` child route.
  const isDone = done
  const [marking, setMarking] = useState(false)
  const [forcing, setForcing] = useState(false)

  // Base path for this session, so the sub-screens can be reached from here.
  const sessionPath =
    activeSessionId != null ? `/groups/${groupSlug}/session/${activeSessionId}` : null

  const handleSend = (text: string) => void sendUserMessage(groupId, text, activeSessionId)

  // Host ends the session early over the answers gathered so far, then opens
  // results. The gateway broadcasts session:picks; the picks screen polls until
  // generation lands. Guard against a double-click during the request.
  const handleForceFinish = async () => {
    if (forcing) return
    setForcing(true)
    try {
      await forceFinish(groupId)
      if (sessionPath) navigate(`${sessionPath}/picks`)
    } catch {
      // Generation failed to start — stay put so the host can retry / the timer
      // can fall back; the button re-enables below.
    } finally {
      setForcing(false)
    }
  }

  const handleDone = async () => {
    if (marking) return // guard against a double-click during the REST round-trip
    setMarking(true)
    // Mark ready over REST — the gateway broadcasts session:member_done and (when
    // this is the last finish) auto-generates results, which arrive via
    // session:picks. Every client reconciles from the echo.
    if (activeSessionId != null) {
      try {
        await setReady(activeSessionId, true)
      } catch {
        // Even if the REST call fails, advance this user's own UI so they aren't
        // stuck; the broadcast reconciles the shared roster when it lands.
        setMemberDone(groupId, currentUserId)
      }
    } else {
      setMemberDone(groupId, currentUserId)
    }
    if (sessionPath) navigate(`${sessionPath}/done`)
  }

  // Guards (after every hook, so the hook order never changes):
  //   none     → the group has no open session, so this URL is stale. Back to the chat.
  //   mismatch → the URL names a DIFFERENT session than the live one (an old link).
  //              activeSessionId is the source of truth; the param is only validated.
  // `replace` keeps the dead URL out of the history stack.
  if (binding === 'none' || (binding === 'bound' && activeSessionId !== urlSessionId)) {
    return <Navigate to={`/groups/${groupSlug}`} replace />
  }
  // Still asking the gateway — hold the frame rather than flashing an empty chat.
  if (binding !== 'bound') {
    return (
      <div className="flex h-screen items-center justify-center bg-surface">
        <Spinner size="lg" className="text-primary" />
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-surface">
      {/* Full-width session bar: "Your food agent" + live countdown (center) */}
      <SessionTopBar groupId={groupId} />

      <div className="flex flex-1 overflow-hidden">
        <GroupsSidebar />

        {/* Center: chat (always visible) */}
        <div className="flex flex-1 flex-col">
          {/* Dark chat header — matches column header height */}
          <div className={cn('flex items-center gap-3 bg-surface-inverse px-4', COLUMN_HEADER_H)}>
            <button
              onClick={() => navigate(`/groups/${groupSlug}`)}
              className="flex h-8 w-8 items-center justify-center rounded-pill text-white/80 hover:bg-white/10"
            >
              <Icon name="chevron-left" size={18} />
            </button>
            <div>
              <p className="flex items-center gap-1.5 text-overline uppercase tracking-wide text-white/50">
                <Icon name="lock" size={10} /> Private · only you can see this
              </p>
              <p className="text-sm font-semibold text-white">Your food agent</p>
            </div>
          </div>

          {/* Conversation always visible; the done pill renders in-stream. */}
          <ChatStream done={isDone} groupId={groupId} />

          {!isDone ? (
            <>
              {/* Quick-reply chips — follow the question the agent just asked. */}
              {quickReplies.length > 0 && (
                <div className="flex flex-wrap gap-2 px-5 pb-1 pt-2">
                  {quickReplies.map((q) => (
                    <button
                      key={q}
                      disabled={sending}
                      onClick={() => handleSend(q)}
                      className="rounded-pill border border-border-strong bg-surface-raised px-3 py-1.5 text-xs font-medium text-text hover:bg-surface-sunken disabled:opacity-50"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              )}
              <VoiceComposer onSend={handleSend} disabled={sending} privacyNote />
              {/* "All set" banner: once the agent has nothing left to ask, nudge
                  the user to finish while making clear they can still make changes. */}
              {allSet && (
                <div className="mx-4 mt-2 flex items-start gap-2 rounded-input border border-success/40 bg-success/10 px-3 py-2 text-xs text-text">
                  <span className="mt-0.5 text-success">
                    <Icon name="check" size={14} />
                  </span>
                  <span>
                    You're good to go — I have everything I need. Want to change
                    anything? Just tell me. Otherwise, finish below.
                  </span>
                </div>
              )}
              {/* Prominent finish CTA — the primary way to end the conversation.
                  Turns accent once the agent is satisfied, to signal it's ready. */}
              <div className="border-t border-border bg-surface-raised p-4">
                <Button
                  fullWidth
                  size="lg"
                  variant={allSet ? 'accent' : 'primary'}
                  isLoading={marking}
                  rightIcon={<Icon name="arrow-right" size={16} />}
                  onClick={() => void handleDone()}
                >
                  I'm Finished
                </Button>
              </div>
            </>
          ) : (
            // Done: the conversation + noted panel stay visible for review. The
            // footer shows a waiting state until the group's results are ready,
            // then a prominent way into them.
            <div className="border-t border-border bg-surface-raised p-4">
              {recommendation != null ? (
                <Button
                  fullWidth
                  size="lg"
                  variant="accent"
                  rightIcon={<Icon name="arrow-right" size={16} />}
                  onClick={() => sessionPath && navigate(`${sessionPath}/picks`)}
                >
                  See the group's results
                </Button>
              ) : (
                <div className="flex flex-col items-center gap-2 py-1 text-center">
                  <span className="flex items-center gap-2 text-sm font-medium text-text">
                    <Spinner size="sm" /> Waiting for others
                  </span>
                  <span className="text-xs text-text-muted">
                    {doneCount} of {progressTotal} finished · you can review your
                    answers while you wait
                  </span>
                  {/* Host can stop waiting and generate results over the answers so
                      far, rather than blocking on every member finishing. */}
                  {isHost && (
                    <Button
                      variant="secondary"
                      size="sm"
                      isLoading={forcing}
                      leftIcon={<Icon name="sparkles" size={14} />}
                      onClick={() => void handleForceFinish()}
                    >
                      Force finish &amp; see results
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right: progress + noted */}
        <aside className="flex w-60 shrink-0 flex-col border-l border-border bg-surface-panel">
          <div className={cn('flex flex-col justify-center border-b border-border px-4', COLUMN_HEADER_H)}>
            <GroupProgressPanel headerOnly groupId={groupId} />
          </div>
          <div className="flex flex-col gap-5 overflow-y-auto p-4">
            <GroupProgressPanel rosterOnly groupId={groupId} />
            <NotedSoFarPanel groupId={groupId} />
          </div>
        </aside>
      </div>
    </div>
  )
}
