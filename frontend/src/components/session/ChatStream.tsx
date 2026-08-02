import { ChatMessage } from './ChatMessage'
import { AgentTypingBubble } from './AgentTypingBubble'
import { Icon } from '@/components/ui'
import { useChatStore, selectChatMessages, selectSending } from '@/stores/chatStore'
import { useScrollToBottom } from '@/hooks/useScrollToBottom'
import { useNewItemIds } from '@/hooks/useNewItemIds'

export interface ChatStreamProps {
  /** The group whose transcript to render (chat state is keyed by group). */
  groupId: number
  /** When true, appends the "You're done · waiting for the group" pill in-stream. */
  done?: boolean
}

export function ChatStream({ groupId, done = false }: ChatStreamProps) {
  const messages = useChatStore(selectChatMessages(groupId))
  // The agent is composing a reply — show the "…" typing bubble until it lands.
  const sending = useChatStore(selectSending(groupId))
  // +1 on send/reply → smooth; the "done" pill and the typing bubble aren't
  // messages, so fold them into the count so appending either nudges to bottom.
  const endRef = useScrollToBottom<HTMLDivElement>(
    messages.length + (done ? 1 : 0) + (sending ? 1 : 0),
  )
  // Only genuinely new messages pop; the opening history renders static.
  const newIds = useNewItemIds(messages.map((m) => m.id))

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-gutter">
      {messages.map((m) => (
        <ChatMessage key={m.id} message={m} isNew={newIds.has(m.id)} />
      ))}
      {/* Food agent typing "…" while its analyze reply is in flight. */}
      <AgentTypingBubble visible={sending} />
      {done && (
        <div className="flex justify-center pt-1">
          <span className="flex items-center gap-2 rounded-pill border border-border bg-surface-raised px-4 py-2 text-body text-text-muted shadow-sm">
            <span className="text-success-text">
              <Icon name="check" size={14} />
            </span>
            You're finished · waiting for others
          </span>
        </div>
      )}
      <div ref={endRef} />
    </div>
  )
}
