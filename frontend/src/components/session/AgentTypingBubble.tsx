import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { EASE } from '@/lib/motion'

export interface AgentTypingBubbleProps {
  /** True while the food agent's reply is in flight (chatStore.sending). */
  visible: boolean
}

// The food agent's "…" typing indicator: mirrors the agent message layout in
// ChatMessage (🍽 header + raised bubble) but with three bouncing dots instead
// of text, shown while the analyze round-trip is in flight. Distinct from the
// group-chat TypingIndicator, which stacks human typers' avatars.
export function AgentTypingBubble({ visible }: AgentTypingBubbleProps) {
  const reduce = useReducedMotion()

  return (
    <AnimatePresence initial={false}>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: reduce ? 0 : 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: reduce ? 0 : 6 }}
          transition={{ duration: reduce ? 0.15 : 0.22, ease: EASE }}
          className="flex flex-col gap-1.5"
          aria-label="Food agent is typing"
          role="status"
        >
          <div className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-pill bg-surface-inverse text-[10px] text-on-inverse">
              🍽
            </span>
            <span className="text-overline font-semibold uppercase tracking-wide text-text-muted">
              Food agent
            </span>
          </div>
          <div className="w-fit rounded-2xl border border-border bg-surface-raised px-4 py-3 shadow-sm">
            <span className="flex items-center gap-1" aria-hidden="true">
              {[0, 150, 300].map((delay) => (
                <span
                  key={delay}
                  className="h-1.5 w-1.5 animate-bounce rounded-pill bg-text-muted"
                  style={{ animationDelay: `${delay}ms` }}
                />
              ))}
            </span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
