import { useEffect, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { Icon } from '@/components/ui'
import { useVoiceInput } from '@/hooks/useVoiceInput'
import { cn } from '@/utils/cn'

// Resting bar heights (px) for the listening waveform. When motion is allowed
// each bar oscillates around its base height so the row reads like a live audio
// signal; reduced-motion renders these static (the prior behavior).
const WAVE_BARS = [6, 12, 20, 10, 16, 8, 22, 12, 6, 14, 9, 18, 7, 15]

export interface VoiceComposerProps {
  onSend: (text: string) => void
  disabled?: boolean
  /** Placeholder for the text input. */
  placeholder?: string
  /** Show the "Only you can see this" privacy caption (agent chat only). */
  privacyNote?: boolean
  /**
   * Optional typing-presence callback (group chat only). Called with `true` on
   * keystroke and `false` after a ~2s pause or on send. Agent chat omits it.
   */
  onTyping?: (isTyping: boolean) => void
}

// How long after the last keystroke we consider the user "stopped typing".
const TYPING_IDLE_MS = 2000

// Shared message bar used by BOTH the agent chat and the group chat: a
// prominent dark circular mic button, a fully-rounded pill text input, and a
// circular send button. While listening, the mic turns orange and a waveform +
// "Listening…" shows in the pill.
export function VoiceComposer({
  onSend,
  disabled,
  placeholder = 'Or type a message...',
  privacyNote = false,
  onTyping,
}: VoiceComposerProps) {
  const { transcript, listening, resetTranscript, supported, start, stop } = useVoiceInput()
  const [text, setText] = useState('')
  const reduce = useReducedMotion()

  const displayValue = listening ? transcript : text

  // Typing-presence debounce: fire onTyping(true) on the first keystroke of a
  // burst, then reset a timer; when it lapses (or on send/unmount) fire (false).
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isTypingRef = useRef(false)

  const stopTyping = () => {
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = null
    if (isTypingRef.current) {
      isTypingRef.current = false
      onTyping?.(false)
    }
  }

  const bumpTyping = () => {
    if (!onTyping) return
    if (!isTypingRef.current) {
      isTypingRef.current = true
      onTyping(true)
    }
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = setTimeout(stopTyping, TYPING_IDLE_MS)
  }

  // Emit "stopped" if the composer unmounts mid-type (e.g. switching rooms).
  useEffect(() => () => stopTyping(), [])

  const handleSend = () => {
    const value = displayValue.trim()
    if (!value) return
    onSend(value)
    setText('')
    resetTranscript()
    stopTyping()
    if (listening) stop()
  }

  const toggleMic = () => {
    if (listening) stop()
    else {
      resetTranscript()
      start()
    }
  }

  return (
    // Two divs on purpose: the outer one carries pb-safe-b so the composer clears
    // the iOS home indicator (the page paints under it via viewport-fit=cover),
    // while the inner one keeps the visual padding. Both on one element would be
    // two competing padding-bottom utilities.
    <div className="shrink-0 border-t border-border bg-surface-raised pb-safe-b">
      <div className="px-4 pb-3 pt-3">
        <div className="flex items-center gap-3">
          {/* Distinct circular mic button */}
          {supported && (
            <button
              type="button"
              aria-label={listening ? 'Stop listening' : 'Start voice input'}
              disabled={disabled}
              onClick={toggleMic}
              className={cn(
                'relative flex h-11 w-11 shrink-0 items-center justify-center rounded-pill shadow-sm transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring',
                'disabled:cursor-not-allowed disabled:opacity-50',
                listening
                  ? 'bg-primary text-on-primary'
                  : 'bg-surface-inverse text-white hover:opacity-90',
              )}
            >
              {/* Radiating ring while listening — feels active without the whole
                  button pulsing. Reduced-motion users get the solid fill only. */}
              {listening && !reduce && (
                <span className="pointer-events-none absolute inset-0 animate-wave rounded-pill bg-primary" />
              )}
              {/* Filled glyph while active so it reads as "on". */}
              <Icon name="mic" size={18} filled={listening} className="relative" />
            </button>
          )}

          {/* Rounded pill input (or waveform while listening) */}
          {listening ? (
            <div className="flex h-11 min-w-0 flex-1 items-center gap-3 rounded-pill bg-surface-sunken px-5">
              {/* min-w-0 + overflow-hidden: 14 bars plus "Listening…" overflow a
                  390px row once the mic and send buttons take their share. */}
              <div className="flex items-center gap-0.5 overflow-hidden" aria-hidden="true">
                {WAVE_BARS.map((h, i) =>
                  reduce ? (
                    <span
                      key={i}
                      className="w-0.5 rounded-pill bg-text/70"
                      style={{ height: `${h}px` }}
                    />
                  ) : (
                    <motion.span
                      key={i}
                      className="w-0.5 shrink-0 rounded-pill bg-text/70"
                      animate={{ height: [h, Math.min(h + 8, 24), Math.max(h - 4, 4), h] }}
                      transition={{
                        duration: 0.9 + (i % 4) * 0.15,
                        repeat: Infinity,
                        ease: 'easeInOut',
                        delay: i * 0.06,
                      }}
                      style={{ height: `${h}px` }}
                    />
                  ),
                )}
              </div>
              <span className="shrink-0 text-body text-text-muted">Listening…</span>
            </div>
          ) : (
            <input
              value={displayValue}
              disabled={disabled}
              placeholder={placeholder}
              onChange={(e) => {
                setText(e.target.value)
                if (e.target.value) bumpTyping()
                else stopTyping()
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSend()
              }}
              className={cn(
                'h-11 min-w-0 flex-1 rounded-pill bg-surface-sunken px-5 text-body text-text',
                'placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-focus-ring',
              )}
            />
          )}

          {/* Circular send button */}
          <button
            type="button"
            aria-label="Send message"
            disabled={disabled || !displayValue.trim()}
            onClick={handleSend}
            className={cn(
              // tap-target: the pill stays 36px (design system) while the hit area
              // grows to 44px — the annotation is explicit about not resizing it.
              'tap-target flex h-9 w-9 shrink-0 items-center justify-center rounded-pill bg-surface-sunken text-text-muted transition-colors',
              'hover:bg-surface-inverse hover:text-white',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring',
              'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-surface-sunken disabled:hover:text-text-muted',
            )}
          >
            <Icon name="send" size={15} />
          </button>
        </div>

        {privacyNote && (
          <p className="mt-2 text-center text-caption text-text-subtle">
            Only you can see this · your privacy is protected
          </p>
        )}
      </div>
    </div>
  )
}
