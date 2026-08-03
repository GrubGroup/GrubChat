import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon, IconButton, Spinner } from '@/components/ui'
import { fetchVoicePreview } from '@/api/voiceApi'

interface VoicePreviewButtonProps {
  /** Cartesia voice id to audition. Changing it stops any clip in flight. */
  voiceId: string
  /** Display name, used only to build the accessible label ("Preview Caroline"). */
  voiceName: string
  /**
   * Called with a user-facing message when a preview fails, and with null when
   * one starts or succeeds. The row this button sits in is too tight for inline
   * error text, so the parent renders it.
   */
  onError?: (message: string | null) => void
  className?: string
}

// Rendered clips, kept for the life of the page: voice id -> object URL.
//
// The transcript is fixed server-side, so a given voice always produces the same
// audio — re-fetching it on every click would bill a TTS generation to hear the
// same four seconds again. ai_service caches its render too; this cache is what
// keeps a repeat click from even leaving the browser.
//
// The URLs are deliberately never revoked. They are bounded by the voice
// allowlist (four entries today), a whole page load is their lifetime, and
// revoking on unmount would throw away work the user is likely to want again the
// moment they reopen settings.
const clipCache = new Map<string, string>()

type PreviewState = 'idle' | 'loading' | 'playing'

// "Hear this voice" for the settings voice picker — the point being that choosing
// a voice shouldn't require starting a real session to find out what it sounds
// like. One button, three states: play / spinner / stop.
export function VoicePreviewButton({
  voiceId,
  voiceName,
  onError,
  className,
}: VoicePreviewButtonProps) {
  const [state, setState] = useState<PreviewState>('idle')
  const audioRef = useRef<HTMLAudioElement | null>(null)
  // Bumped by every stop() and every new request. An in-flight fetch compares the
  // token it captured against this before touching state or starting playback, so
  // switching voices (or unmounting) mid-request can't start the OLD clip after.
  const runRef = useRef(0)

  const stop = useCallback(() => {
    runRef.current += 1
    const audio = audioRef.current
    if (audio) {
      audio.pause()
      audio.currentTime = 0
      audioRef.current = null
    }
    setState('idle')
  }, [])

  // Stop on unmount, and whenever the selected voice changes — leaving the old
  // voice talking over a new selection is exactly the confusion this UI exists to
  // remove. (Runs harmlessly on mount, when nothing is playing.)
  useEffect(() => stop, [stop, voiceId])

  const play = useCallback(async () => {
    const run = (runRef.current += 1)
    const stale = () => runRef.current !== run
    onError?.(null)
    setState('loading')
    try {
      let url = clipCache.get(voiceId)
      if (!url) {
        const blob = await fetchVoicePreview(voiceId)
        url = URL.createObjectURL(blob)
        clipCache.set(voiceId, url)
      }
      if (stale()) return

      const audio = new Audio(url)
      audio.onended = () => {
        if (stale()) return
        audioRef.current = null
        setState('idle')
      }
      audioRef.current = audio
      await audio.play()
      if (stale()) {
        // Selection changed while the play() promise settled — stop() already ran
        // against the previous audio element, so silence this one too.
        audio.pause()
        return
      }
      setState('playing')
    } catch (err) {
      if (stale()) return
      audioRef.current = null
      setState('idle')
      onError?.(
        err instanceof Error && err.message
          ? err.message
          : 'Could not play a preview. Please try again.',
      )
    }
  }, [voiceId, onError])

  const label =
    state === 'playing' ? `Stop the ${voiceName} preview` : `Play a preview of ${voiceName}`

  return (
    <IconButton
      // `type` matters: this button sits inside settings forms, and an unset type
      // defaults to "submit".
      type="button"
      label={label}
      variant="ghost"
      disabled={state === 'loading'}
      onClick={() => (state === 'playing' ? stop() : void play())}
      icon={
        state === 'loading' ? (
          <Spinner size="sm" />
        ) : (
          <Icon name={state === 'playing' ? 'pause' : 'play'} size={16} filled />
        )
      }
      className={className}
    />
  )
}
