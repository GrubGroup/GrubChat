import { useEffect, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { Icon } from '@/components/ui'
import { useVoiceInput } from '@/hooks/useVoiceInput'
import type { VoiceController } from '@/types/voice'
import { cn } from '@/utils/cn'

// Resting bar heights (px) for the listening waveform. When motion is allowed
// each bar oscillates around its base height so the row reads like a live audio
// signal; reduced-motion renders these static (the prior behavior).
const WAVE_BARS = [6, 12, 20, 10, 16, 8, 22, 12, 6, 14, 9, 18, 7, 15]

export interface VoiceComposerProps {
  /**
   * Send the composed message. `source` reports how it was entered — 'voice'
   * when it came from the mic transcript, 'text' when typed. The analyze
   * endpoint uses this to tolerate speech-to-text noise (`message_source`), so
   * losing it here would silently disable that tolerance.
   */
  onSend: (text: string, source: 'voice' | 'text') => void
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
  /**
   * Optional externally-supplied voice controller. When provided (agent chat's
   * hands-free loop), it drives the mic/caption/mute instead of the built-in
   * Web Speech `useVoiceInput`. In this mode a spoken turn is submitted
   * SERVER-SIDE by the WS loop, so the composer must NOT also call `onSend` for
   * dictation (that would fire a duplicate HTTP /analyze). Omitted in group chat,
   * where dictation still flows through `onSend`.
   */
  controller?: VoiceController
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
  controller,
}: VoiceComposerProps) {
  // Hoist the fallback hook so it's ALWAYS called (rules of hooks — a conditional
  // `controller ?? useVoiceInput()` both violates the hooks rule AND fails to
  // typecheck against the union). Annotate the seam so the optional loop-only
  // fields (speaking/muted/amplitude/toggleMute) are visible either way.
  const fallback: VoiceController = useVoiceInput()
  const v: VoiceController = controller ?? fallback
  const { transcript, listening, resetTranscript, supported, start, stop } = v
  // In controller mode a dictated turn is submitted server-side by the WS loop, so
  // the composer must not treat the transcript as a to-be-sent value.
  const voiceLoop = controller != null
  const [text, setText] = useState('')
  const reduce = useReducedMotion()

  // While the mic is on we show the caption in the pill's waveform strip, never in
  // the text input's value — in voice-loop mode the transcript is NOT a draft to
  // send, so it must not populate `displayValue` (which the send button reads).
  const displayValue = voiceLoop ? text : listening ? transcript : text

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
    // In voice-loop mode displayValue is ALWAYS the typed `text` (never the
    // transcript), so a manual send is always a typed turn — the spoken turn was
    // already submitted server-side by the WS loop. Outside voice-loop mode,
    // `listening` marks a dictated Web Speech turn (group chat). Capture the source
    // before stop() flips `listening`.
    const source: 'voice' | 'text' = !voiceLoop && listening ? 'voice' : 'text'
    onSend(value, source)
    setText('')
    resetTranscript()
    stopTyping()
    // Only the Web Speech path stops the mic on send; the hands-free loop keeps
    // listening across turns.
    if (!voiceLoop && listening) stop()
  }

  const toggleMic = () => {
    if (listening) stop()
    else {
      resetTranscript()
      start()
    }
  }

  return (
    <div className="border-t border-border bg-surface-raised px-4 pb-3 pt-3">
      <div className="flex items-center gap-3">
        {/* Distinct circular mic button. NOTE: in voice-loop mode this is NOT gated
            on `disabled` — the agent-chat page passes disabled={sending}, and during
            the ~1s analyze window barge-in and mute are exactly when the mic controls
            must stay live. The Web Speech path keeps the original disabled behavior. */}
        {supported && (
          <button
            type="button"
            aria-label={listening ? 'Stop listening' : 'Start voice input'}
            disabled={voiceLoop ? false : disabled}
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
            {/* In the hands-free voice loop, tapping the orange button STOPS the
                recording — so it shows a filled stop square, not a mic. Elsewhere
                (Web Speech dictation) the mic glyph still reads as "on". */}
            {voiceLoop && listening ? (
              <Icon name="square" size={24} filled className="relative" />
            ) : (
              <Icon name="mic" size={18} filled={listening} className="relative" />
            )}
          </button>
        )}

        {/* Mute button — voice-loop only, and only while the mic is live. Muting
            keeps the loop running (the client streams silence upstream so Flux's
            ~60s idle cap never fires); it just stops sending real mic bytes. */}
        {voiceLoop && listening && v.toggleMute && (
          <button
            type="button"
            aria-label={v.muted ? 'Unmute microphone' : 'Mute microphone'}
            onClick={v.toggleMute}
            className={cn(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-pill transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring',
              v.muted
                ? 'bg-primary/15 text-primary'
                : 'bg-surface-sunken text-text-muted hover:bg-surface-inverse hover:text-white',
            )}
          >
            {/* Action-semantics like the stop button: the glyph shows what a tap
                DOES. Live → slashed mic ("tap to mute"); muted → plain mic ("tap to
                unmute"). Current state is conveyed by the button's color (orange
                tint when muted). No `filled` — mic-off is open strokes with no solid
                variant, so filling it would self-intersect into artifacts. */}
            <Icon name={v.muted ? 'mic' : 'mic-off'} size={15} />
          </button>
        )}

        {/* Rounded pill input (or waveform while listening) */}
        {listening ? (
          <div className="flex h-11 flex-1 items-center gap-3 rounded-pill bg-surface-sunken px-5">
            <div className="flex items-center gap-0.5" aria-hidden="true">
              {WAVE_BARS.map((h, i) =>
                // In voice-loop mode drive the bars off the REAL input level
                // (controller.amplitude) so the waveform reflects the actual mic,
                // not a canned animation. Muted → flat. Web Speech path keeps the
                // original oscillation (it has no amplitude signal).
                voiceLoop ? (
                  <span
                    key={i}
                    className="w-0.5 rounded-pill bg-text/70 transition-[height] duration-100"
                    style={{
                      height: v.muted
                        ? '3px'
                        : `${Math.max(3, Math.min(24, h * (0.35 + (v.amplitude ?? 0) * 1.6)))}px`,
                    }}
                  />
                ) : reduce ? (
                  <span
                    key={i}
                    className="w-0.5 rounded-pill bg-text/70"
                    style={{ height: `${h}px` }}
                  />
                ) : (
                  <motion.span
                    key={i}
                    className="w-0.5 rounded-pill bg-text/70"
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
            <span className="text-sm text-text-muted">
              {voiceLoop
                ? v.muted
                  ? 'Muted'
                  : v.speaking
                    ? 'Agent speaking…'
                    : transcript
                      ? transcript
                      : 'Listening…'
                : 'Listening…'}
            </span>
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
              'h-11 flex-1 rounded-pill bg-surface-sunken px-5 text-sm text-text',
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
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-pill bg-surface-sunken text-text-muted transition-colors',
            'hover:bg-surface-inverse hover:text-white',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring',
            'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-surface-sunken disabled:hover:text-text-muted',
          )}
        >
          <Icon name="send" size={15} />
        </button>
      </div>

      {/* Transient voice-loop status/error (e.g. "voice busy — showing text only",
          mic-permission denied). Only in controller mode; group chat has no such
          field. Non-blocking — the text composer stays usable underneath. */}
      {voiceLoop && v.error && (
        <p className="mt-2 text-center text-caption text-error">{v.error}</p>
      )}

      {privacyNote && (
        <p className="mt-2 text-center text-caption text-text-subtle">
          Only you can see this · your privacy is protected
        </p>
      )}
    </div>
  )
}
