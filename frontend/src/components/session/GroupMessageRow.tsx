import type { GroupMessage, SessionMember } from '@/types'
import { Avatar } from '@/components/ui'
import { cn } from '@/utils/cn'
import { memberColor } from '@/constants/memberColors'
import { nameForMember } from '@/utils/memberName'

export interface GroupMessageRowProps {
  message: GroupMessage
  currentUserId: number
  /** True only for a message that just arrived — triggers the bubble pop. */
  isNew?: boolean
  /** Session roster, so a chat author's name resolves to their real name. */
  members?: SessionMember[]
}

// Format an ISO timestamp as a short local time, e.g. "11:42 AM".
function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function GroupMessageRow({ message, currentUserId, isNew = false, members }: GroupMessageRowProps) {
  // Restaurant recommendations no longer appear in the group chat — they live in
  // the session/results flow only. Swallow any legacy SESSION_BLOCK row (its text
  // is empty, so falling through would render a blank bubble).
  if (message.type === 'session_block') {
    return null
  }

  // Freshly arrived messages pop in (scale 0→100% with a spring overshoot, via
  // the animate-bubble-pop CSS utility). History renders static.
  const pop = isNew ? 'animate-bubble-pop' : undefined

  // System lines (e.g. "Sophie has left the group") render as a centered divider,
  // matching the "… started a session" style.
  if (message.type === 'system') {
    return (
      <div className={cn('flex items-center gap-3 py-1 text-caption-touch text-text-muted md:text-caption', pop)}>
        <span className="h-px flex-1 bg-border" />
        {message.text}
        <span className="h-px flex-1 bg-border" />
      </div>
    )
  }

  const isOwn = message.userId === currentUserId
  const name = message.name ?? nameForMember(message.userId, members)
  const time = formatTime(message.at)

  if (isOwn) {
    return (
      <div className={cn('flex items-end justify-end gap-2', pop)}>
        <span className="shrink-0 text-caption-touch text-text-muted md:text-caption">{time}</span>
        {/* break-words: an unbroken run (a pasted URL) would otherwise blow past
            the bubble and give the whole page horizontal scroll at 390px. */}
        <div className="max-w-[70%] break-words rounded-2xl rounded-tr-md bg-surface-inverse px-4 py-2.5 text-body-touch text-white md:px-3.5 md:py-2 md:text-body">
          {message.text}
        </div>
      </div>
    )
  }

  return (
    <div className={cn('flex min-w-0 items-start gap-2.5', pop)}>
      <Avatar name={name} size="sm" colorClass={memberColor(message.userId ?? -1)} />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-caption-touch text-text-muted md:text-caption">{name}</span>
        <div className="flex min-w-0 items-end gap-2">
          {/* max-w-md (448px) is a no-op at 390px, so bubbles ran edge-to-edge
              with no room for the timestamp — cap by percentage on mobile. */}
          <div className="max-w-[85%] break-words rounded-2xl rounded-tl-md bg-surface-sunken px-4 py-2.5 text-body-touch text-text md:max-w-md md:px-3.5 md:py-2 md:text-body">
            {message.text}
          </div>
          <span className="shrink-0 text-caption-touch text-text-muted md:text-caption">{time}</span>
        </div>
      </div>
    </div>
  )
}
