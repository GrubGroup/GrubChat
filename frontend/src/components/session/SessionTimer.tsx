import { useEffect, useRef } from 'react'
import { Icon } from '@/components/ui'
import { cn } from '@/utils/cn'
import { useSessionCountdown } from '@/hooks/useSessionCountdown'

export interface SessionTimerProps {
  /** ISO time the countdown started from (null = not started; shows full time). */
  startedAt: string | null
  /** Session.time_limit — countdown length in minutes. */
  minutes: number
  /** Fired ONCE when the countdown reaches zero (host client triggers picks). */
  onExpire?: () => void
}

// mm:ss formatter (e.g. 605 -> "10:05").
function formatMmSs(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

// Live session countdown pill. Ticks each second from `startedAt`; turns urgent
// (primary) under a minute and fires `onExpire` exactly once at zero.
export function SessionTimer({ startedAt, minutes, onExpire }: SessionTimerProps) {
  const { secondsLeft, expired } = useSessionCountdown(startedAt, minutes)
  const firedRef = useRef(false)

  useEffect(() => {
    if (expired && !firedRef.current) {
      firedRef.current = true
      onExpire?.()
    }
  }, [expired, onExpire])

  const urgent = secondsLeft <= 60 && startedAt != null

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-pill px-3 py-1 text-body font-semibold tabular-nums',
        expired
          ? 'bg-error/10 text-error-text'
          : urgent
            ? 'bg-primary/10 text-primary-hover'
            : 'bg-surface-sunken text-text-muted',
      )}
      aria-live="polite"
    >
      <Icon name="bell" size={13} />
      {expired ? 'Time’s up' : formatMmSs(secondsLeft)}
    </span>
  )
}
