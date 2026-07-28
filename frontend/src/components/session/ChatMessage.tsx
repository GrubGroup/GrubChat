import type { ChatMessage as ChatMessageType } from '@/types'
import { cn } from '@/utils/cn'

export interface ChatMessageProps {
  message: ChatMessageType
  /** True only for a message that just arrived — triggers the bubble pop. */
  isNew?: boolean
}

export function ChatMessage({ message, isNew = false }: ChatMessageProps) {
  let content
  if (message.role === 'system') {
    content = (
      <p className="mx-auto max-w-md text-center text-caption-touch text-text-muted md:text-caption">{message.text}</p>
    )
  } else if (message.role === 'user') {
    content = (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-tr-lg bg-bubble-user px-4 py-3 text-body-touch text-white md:px-3.5 md:py-2.5 md:text-body">
          {message.text}
        </div>
      </div>
    )
  } else {
    // Agent
    content = (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span className="flex h-5 w-5 items-center justify-center rounded-pill bg-surface-inverse text-[10px] text-white">
            🍽
          </span>
          <span className="text-overline font-semibold uppercase tracking-wide text-text-muted">
            Food agent
          </span>
        </div>
        <div className="rounded-2xl border border-border bg-surface-raised px-4 py-3.5 text-body-touch text-text shadow-sm md:py-3 md:text-body">
          {message.text}
        </div>
      </div>
    )
  }

  // Freshly arrived messages pop in (scale 0→100% with a spring overshoot, via
  // the animate-bubble-pop CSS utility). History renders static.
  return <div className={cn(isNew && 'animate-bubble-pop')}>{content}</div>
}
