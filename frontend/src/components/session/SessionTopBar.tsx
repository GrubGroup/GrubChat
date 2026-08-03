import { Icon } from '@/components/ui'
import { AgentAvatar } from './AgentAvatar'
import { SessionTimer } from './SessionTimer'
import { COLUMN_HEADER_H } from '@/components/layout/AppSidebar'
import { cn } from '@/utils/cn'
import {
  useSessionStore,
  selectSession,
  selectActiveSessionId,
  selectStartedAt,
} from '@/stores/sessionStore'

export interface SessionTopBarProps {
  /** The group whose session to reflect (session state is keyed by group). */
  groupId: number
  /** Center label; the wireframe uses "Your food agent". */
  label?: string
}

// Full-width session bar mounted ABOVE the three-column layout. Shows the private
// "Your food agent" label (left) and the live countdown (center). When the timer
// expires, the HOST client alone triggers generation (force_partial=true) — the
// gateway broadcasts session:picks to everyone, so non-hosts do nothing here.
//
// Desktop only: below `md` this bar plus the w-60 aside would be two pieces of
// chrome above a 390px conversation. MobileSessionStrip collapses both into one
// tappable row instead.
export function SessionTopBar({ groupId, label = 'Your food agent' }: SessionTopBarProps) {
  const session = useSessionStore(selectSession(groupId))
  const activeSessionId = useSessionStore(selectActiveSessionId(groupId))
  const startedAt = useSessionStore(selectStartedAt(groupId))
  // The timer is now only a FALLBACK: auto-complete generates results the moment
  // every member finishes (server-side). The host-only
  // expiry generation is centralized in the store, shared with the group-chat
  // card timer — see sessionStore.triggerExpiryGeneration.
  const triggerExpiryGeneration = useSessionStore((s) => s.triggerExpiryGeneration)

  if (activeSessionId == null || session == null) return null

  return (
    <div
      className={cn(
        'relative hidden items-center justify-between border-b border-border bg-surface-panel px-5 md:flex',
        COLUMN_HEADER_H,
      )}
    >
      <div className="flex items-center gap-2">
        <AgentAvatar size={24} />
        <span className="flex items-center gap-1.5 text-body font-semibold text-text">
          {label}
        </span>
      </div>

      <div className="absolute left-1/2 -translate-x-1/2">
        <SessionTimer
          startedAt={startedAt}
          minutes={session.time_limit}
          onExpire={() => void triggerExpiryGeneration(groupId)}
        />
      </div>

      <div className="flex items-center gap-1.5 text-overline uppercase tracking-wide text-text-muted">
        <Icon name="lock" size={11} /> Private
      </div>
    </div>
  )
}
