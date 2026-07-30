import type { SessionMember } from '@/types'
import { Avatar, Button, Icon } from '@/components/ui'
import { SegmentedProgress } from './SegmentedProgress'
import { SessionTimer } from './SessionTimer'
import { memberColor } from '@/constants/memberColors'
import { nameForMember } from '@/utils/memberName'

type SessionCardState = 'not-joined' | 'continue' | 'waiting' | 'complete'

export interface SessionCardProps {
  state: SessionCardState
  members: SessionMember[]
  readyCount: number
  total: number
  // Countdown anchor + length (from the session), so the card shows the same
  // live timer as the agent-chat top bar while a session is in progress.
  startedAt?: string | null
  minutes?: number
  onJoin?: () => void
  onContinue?: () => void
  onViewResults?: () => void
  // Fired when the countdown reaches zero (host-only generation, centralized).
  onExpire?: () => void
  // Re-open the (preserved) conversation to review answers — shown when waiting.
  onReview?: () => void
  // Whether the viewer hosts this session — gates the "Force finish" action.
  isHost?: boolean
  // Host ends the session early over the answers gathered so far (force_partial).
  onForceFinish?: () => void
  // True while a force-finish request is in flight (disables the button).
  forcing?: boolean
}

// The inline "session in progress" card shown inside the group chat. Its CTA
// changes with state: Join (not yet joined) / Continue (joined, in progress) /
// Review answers + waiting label (user done) / Results (complete).
export function SessionCard({
  state,
  members,
  readyCount,
  total,
  startedAt,
  minutes,
  onJoin,
  onContinue,
  onViewResults,
  onExpire,
  onReview,
  isHost,
  onForceFinish,
  forcing,
}: SessionCardProps) {
  const complete = state === 'complete'
  // The host can end the session early while it's still running (not once complete).
  const canForceFinish = isHost && !complete && onForceFinish != null
  return (
    <div className="rounded-card border border-primary/40 bg-surface-raised p-4 shadow-sm">
      {/* Below `md` the CTA drops to its own FULL-WIDTH row under the status line —
          the wireframe's one intentional deviation from desktop on this frame.
          "Review your answers" alone is wider than what's left of 390px beside
          the label + countdown, so inline is not an option there. */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between md:gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="h-2 w-2 shrink-0 rounded-pill bg-primary" />
          <span className="font-semibold text-text">
            {state === 'waiting'
              ? 'Waiting for others'
              : complete
                ? 'Session complete'
                : 'Session in progress'}
          </span>
          {/* Live countdown while the session runs (not once complete). */}
          {!complete && minutes != null && (
            <SessionTimer startedAt={startedAt ?? null} minutes={minutes} onExpire={onExpire} />
          )}
        </div>
        {state === 'not-joined' && (
          <Button size="sm" fullWidth className="md:w-auto" variant="primary" onClick={onJoin}>
            Join
          </Button>
        )}
        {state === 'continue' && (
          <Button size="sm" fullWidth className="md:w-auto" variant="accent" onClick={onContinue}>
            Continue
          </Button>
        )}
        {state === 'waiting' && (
          <Button size="sm" fullWidth className="md:w-auto" variant="secondary" onClick={onReview}>
            Review your answers
          </Button>
        )}
        {complete && (
          <button
            onClick={onViewResults}
            className="flex h-9 w-full items-center justify-center gap-1.5 rounded-input bg-success px-3 text-caption font-medium text-white md:h-auto md:w-auto md:py-1.5 dark:bg-[#16a34a]"
          >
            <Icon name="utensils" size={12} /> Results
          </button>
        )}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <div className="flex -space-x-1.5">
          {members.slice(0, 6).map((m) => (
            <Avatar
              key={m.user_id}
              name={nameForMember(m.user_id, members)}
              src={m.avatar_url}
              size="sm"
              colorClass={memberColor(m.user_id)}
              className="h-5 w-5 border-2 border-surface-raised text-[8px]"
            />
          ))}
        </div>
        <span className="text-caption text-text-muted">
          {readyCount} of {total} ready
        </span>
      </div>

      <div className="mt-2">
        <SegmentedProgress value={readyCount} total={total} tone="primary" />
      </div>

      {/* Host-only: end the session now over the answers gathered so far. */}
      {canForceFinish && (
        <button
          onClick={onForceFinish}
          disabled={forcing}
          className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-input border border-border px-3 py-1.5 text-caption font-medium text-text-muted hover:bg-surface-sunken hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Icon name="sparkles" size={12} />
          {forcing ? 'Finishing…' : 'Force finish & see results'}
        </button>
      )}
    </div>
  )
}
