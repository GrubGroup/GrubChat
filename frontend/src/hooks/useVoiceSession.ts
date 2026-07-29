import { useCallback, useEffect, useRef, useState } from 'react'
import { getSocket } from '@/lib/socket'
import { useChatStore } from '@/stores/chatStore'
import { useVoicePrefStore } from '@/stores/voicePrefStore'
import type { ConversationTurn, ExtractedSignals } from '@/types'
import type { VoiceController, VoiceFrame } from '@/types/voice'

// Continuous hands-free voice loop for the session agent chat.
//
// Owns three things and nothing else touches them:
//   1. CAPTURE — a 16 kHz AudioContext + the pcm-recorder worklet. The browser
//      resamples to 16 kHz; the worklet reframes to 80 ms linear16 chunks and
//      posts them here, which we relay as `voice:audio` (binary) up to the gateway.
//   2. SOCKET — voice:ready / voice:frame (control) / voice:audio (TTS PCM) /
//      voice:closed / voice:error, on the SAME singleton socket group chat uses
//      (distinct event names, so no collision with useSocket's chat/session ones).
//      Listeners are attached in an effect (so their cleanup detaches the SAME
//      closures — socket.on captures the function value at attach time).
//   3. PLAYBACK — a SEPARATE 44.1 kHz AudioContext (Cartesia's pcm_f32le rate) so
//      a 48 kHz default device doesn't resample every chunk. Chunks are chained on
//      a running cursor with Cartesia's documented scheduling guard.
//
// A voice turn's analyze POST happens SERVER-SIDE (via the WS relay), so it feeds
// the chat store through appendVoiceTranscript/applyVoiceTurn — NOT sendUserMessage
// (which would fire a second, duplicate HTTP /analyze).
//
// Cartesia streams raw pcm_f32le @ 44.1 kHz (RAW_OUTPUT in tts.py) — Float32, no
// WAV header — so each downstream binary chunk decodes as a Float32Array.
const PLAYBACK_SAMPLE_RATE = 44100
const CAPTURE_SAMPLE_RATE = 16000
const WORKLET_URL = '/worklets/pcm-recorder.js'

const emptySignals = (): ExtractedSignals => ({
  dietary_restrictions: [],
  preferred_cuisines: [],
  disliked_cuisines: [],
  budget_min: null,
  budget_max: null,
  occasion: null,
  location_mode: null,
  location_label: null,
  location_lat: null,
  location_lon: null,
  radius_miles: null,
})

export function useVoiceSession(groupId: number, sessionId: number | null): VoiceController {
  const [listening, setListening] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [speaking, setSpeaking] = useState(false)
  const [muted, setMuted] = useState(false)
  const [amplitude, setAmplitude] = useState(0)
  const [error, setError] = useState<string | null>(null)

  // Capture graph.
  const captureCtxRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const workletRef = useRef<AudioWorkletNode | null>(null)
  // Playback graph.
  const playbackCtxRef = useRef<AudioContext | null>(null)
  const nextStartRef = useRef(0)
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set())
  // Float32 needs a 4-byte-aligned length; SSE chunk boundaries aren't guaranteed
  // sample-aligned, so carry the sub-sample remainder across chunks.
  const leftoverRef = useRef<Uint8Array>(new Uint8Array(0))
  // Throttle amplitude state updates (~10 Hz) so a 12.5 Hz worklet doesn't storm
  // React with re-renders.
  const lastAmpAtRef = useRef(0)
  // Track live-ness for async callbacks that outlive a stop().
  const activeRef = useRef(false)
  // "Finishing" — the member answered everything (complete) and we're letting the
  // closing TTS line drain before teardown. While set, the mic is already off and
  // an incoming voice:closed must NOT hard-cut the still-scheduled playback.
  const finishingRef = useRef(false)
  const drainTimerRef = useRef<number | null>(null)
  // Live mute state for the worklet onmessage closure (which captures its value at
  // start()-time); updated in the toggleMute/stop event handlers, never in render.
  const mutedRef = useRef(false)

  // Stop and drop every scheduled TTS source (barge-in / stop / complete).
  const stopPlayback = useCallback(() => {
    for (const src of sourcesRef.current) {
      try {
        src.stop()
      } catch {
        /* already stopped */
      }
    }
    sourcesRef.current.clear()
    nextStartRef.current = 0
    leftoverRef.current = new Uint8Array(0)
    setSpeaking(false)
  }, [])

  // Stop mic capture and tell the server to end the upstream Flux/TTS legs, WITHOUT
  // touching playback — so a buffered closing line can still drain (see finishDrain).
  const stopCapture = useCallback(() => {
    const socket = getSocket()
    socket?.emit('voice:control', { type: 'stop' })
    socket?.emit('voice:stop')
    workletRef.current?.port.close()
    workletRef.current?.disconnect()
    workletRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    void captureCtxRef.current?.close()
    captureCtxRef.current = null
    mutedRef.current = false
    setListening(false)
    setMuted(false)
    setAmplitude(0)
  }, [])

  // Tear the whole loop down NOW: stop capture AND cut playback, close both
  // contexts. The hard path — barge-in-free stop, error, unmount. Safe to call
  // repeatedly. Also runs during a drain (finishingRef) so unmount/explicit-stop
  // cancels the drain timer instead of leaking it. Socket LISTENERS are owned by
  // the effect below, not detached here.
  const stop = useCallback(() => {
    if (!activeRef.current && !finishingRef.current) return
    activeRef.current = false
    finishingRef.current = false
    if (drainTimerRef.current != null) {
      clearTimeout(drainTimerRef.current)
      drainTimerRef.current = null
    }
    stopCapture()
    stopPlayback()
    void playbackCtxRef.current?.close()
    playbackCtxRef.current = null
    setListening(false)
    setSpeaking(false)
    setMuted(false)
    setAmplitude(0)
    setTranscript('')
  }, [stopCapture, stopPlayback])

  // The member answered everything (`complete`): stop the mic immediately but let
  // the closing TTS line finish. PCM arrives faster than real time and is scheduled
  // ~seconds into the future on nextStartRef, so a hard stop() here would src.stop()
  // the still-queued tail and cut the agent off mid-word (the "Great —" cutoff). By
  // `complete` the server has already sent ALL of this turn's PCM (it awaits the full
  // TTS stream before emitting complete), so nextStartRef reflects the whole tail:
  // wait out the remaining buffered duration, then tear down. The subsequent
  // voice:closed is expected and must NOT hard-cut (guarded by finishingRef).
  const finishDrain = useCallback(() => {
    if (!activeRef.current) return
    activeRef.current = false
    finishingRef.current = true
    stopCapture()
    const ctx = playbackCtxRef.current
    const remainingMs = ctx ? Math.max(0, (nextStartRef.current - ctx.currentTime) * 1000) : 0
    drainTimerRef.current = window.setTimeout(() => {
      drainTimerRef.current = null
      finishingRef.current = false
      stopPlayback()
      void playbackCtxRef.current?.close()
      playbackCtxRef.current = null
      setSpeaking(false)
      setTranscript('')
    }, remainingMs + 400) // small pad past the last sample
  }, [stopCapture, stopPlayback])

  // Schedule one downstream PCM chunk on the running cursor.
  const enqueuePcm = useCallback((buf: ArrayBuffer) => {
    const ctx = playbackCtxRef.current
    if (!ctx) return
    // Prepend any carried bytes, then take the largest 4-byte-aligned span.
    const prev = leftoverRef.current
    let bytes: Uint8Array
    if (prev.length) {
      bytes = new Uint8Array(prev.length + buf.byteLength)
      bytes.set(prev, 0)
      bytes.set(new Uint8Array(buf), prev.length)
    } else {
      bytes = new Uint8Array(buf)
    }
    const usable = bytes.byteLength - (bytes.byteLength % 4)
    leftoverRef.current = usable < bytes.byteLength ? bytes.slice(usable) : new Uint8Array(0)
    if (usable === 0) return
    // Copy the usable bytes into a fresh, offset-0 ArrayBuffer so Float32Array
    // construction is aligned even when `bytes` came from a sliced view. Allocate
    // the ArrayBuffer explicitly (not via .buffer.slice, which the lib types widen
    // to ArrayBuffer | SharedArrayBuffer and Float32Array won't accept).
    const aligned = new ArrayBuffer(usable)
    new Uint8Array(aligned).set(bytes.subarray(0, usable))
    const samples = new Float32Array(aligned)
    if (samples.length === 0) return

    const audioBuffer = ctx.createBuffer(1, samples.length, PLAYBACK_SAMPLE_RATE)
    audioBuffer.copyToChannel(samples, 0)
    const src = ctx.createBufferSource()
    src.buffer = audioBuffer
    src.connect(ctx.destination)
    // Cartesia's documented guard: never schedule in the past.
    const startAt = Math.max(nextStartRef.current, ctx.currentTime)
    src.start(startAt)
    nextStartRef.current = startAt + audioBuffer.duration
    setSpeaking(true)
    sourcesRef.current.add(src)
    src.onended = () => {
      sourcesRef.current.delete(src)
      // When the last scheduled source drains, playback is idle again.
      if (sourcesRef.current.size === 0) setSpeaking(false)
    }
  }, [])

  // Handle one downstream JSON control frame.
  const handleFrame = useCallback(
    (frame: VoiceFrame) => {
      const chat = useChatStore.getState()
      switch (frame.type) {
        case 'ready': {
          // Handshake done — re-seed the server with the chat context so a mixed
          // typed+voice session stays coherent (dietary especially: Qa has no
          // dietary column, so only a replayed history carries a typed allergy).
          const cur = chat.byGroup[groupId]
          const history: ConversationTurn[] = (cur?.messages ?? [])
            .filter((m) => m.role === 'user' || m.role === 'agent')
            .map((m) => ({ role: m.role === 'agent' ? 'assistant' : 'user', content: m.text }))
          const current_signals: ExtractedSignals = cur?.currentSignals ?? emptySignals()
          // Read the chosen voice at emit-time (not via a hook dep) so selecting a
          // new voice takes effect on the next session without re-attaching the
          // socket listeners. The server validates it against its allowlist.
          const voice_id = useVoicePrefStore.getState().voiceId
          getSocket()?.emit('voice:control', {
            type: 'start',
            conversation_history: history,
            current_signals,
            voice_id,
          })
          break
        }
        case 'caption':
          // Interim caption drives the in-composer text; the final text becomes the
          // chat row via turn_final, so we clear it there.
          setTranscript(frame.text)
          break
        case 'barge_in':
          // The member started talking over the agent — cut playback immediately.
          stopPlayback()
          break
        case 'turn_final':
          setTranscript('')
          chat.appendVoiceTranscript(groupId, frame.transcript)
          break
        case 'turn_result':
          chat.applyVoiceTurn(groupId, {
            agent_reply: frame.agent_reply,
            extracted_signals: frame.extracted_signals,
            missing_signals: frame.missing_signals,
            is_complete: frame.is_complete,
          })
          break
        case 'speech_end':
          // All PCM for this utterance sent; sources drain on their own onended.
          break
        case 'complete':
          // The member answered everything — stop capturing but let the buffered
          // closing line finish (see finishDrain; a hard stop() cut it off mid-word).
          finishDrain()
          break
        case 'error': {
          // If a turn was in flight (no turn_result yet), this is an analyze failure
          // — clear `sending` and surface an honest notice. Otherwise it's a
          // post-turn TTS degrade ("voice busy — showing text only"): show it as a
          // transient status without a spurious chat line.
          if (chat.byGroup[groupId]?.sending) chat.failVoiceTurn(groupId, frame.message)
          setError(frame.message)
          break
        }
      }
    },
    [groupId, stopPlayback, finishDrain],
  )

  // Attach the voice:* listeners for the hook's lifetime. Attaching in an effect
  // (not start()) means the cleanup detaches the SAME closures — socket.on captures
  // the function value at attach time, so a ref-indirection wouldn't pick up a later
  // handler. Frames only arrive between voice:start and voice:stop, so idle
  // listeners are harmless. Re-runs (rare — only if a callback identity changes)
  // cleanly detach and re-attach.
  useEffect(() => {
    const socket = getSocket()
    if (!socket) return
    const onReady = () => setError(null)
    const onFrame = (f: VoiceFrame) => handleFrame(f)
    const onAudio = (b: ArrayBuffer) => enqueuePcm(b)
    // After `complete` the server closes the socket — that voice:closed is EXPECTED
    // and must not hard-cut the still-draining closing line. finishDrain owns the
    // teardown in that case; only hard-stop on an UNEXPECTED close (mid-session drop).
    const onClosed = () => {
      if (finishingRef.current) return
      stop()
    }
    const onError = (e: { message?: string }) => {
      setError(e?.message ?? 'voice service unavailable')
      stop()
    }
    socket.on('voice:ready', onReady)
    socket.on('voice:frame', onFrame)
    socket.on('voice:audio', onAudio)
    socket.on('voice:closed', onClosed)
    socket.on('voice:error', onError)
    return () => {
      socket.off('voice:ready', onReady)
      socket.off('voice:frame', onFrame)
      socket.off('voice:audio', onAudio)
      socket.off('voice:closed', onClosed)
      socket.off('voice:error', onError)
    }
  }, [handleFrame, enqueuePcm, stop])
  // (finishingRef is a ref, so it needs no dep — the closure reads its live value.)

  const start = useCallback(async () => {
    if (activeRef.current) return
    // If a previous turn's closing line is still draining, hard-tear it down first
    // so start() builds a clean graph (else the pending drain timer would close the
    // freshly-created playback context out from under the new session).
    if (finishingRef.current) stop()
    if (sessionId == null) {
      setError('No active session')
      return
    }
    setError(null)
    try {
      const socket = getSocket()
      if (!socket) {
        setError('Not connected')
        return
      }

      // Mic: AEC on (primary self-hearing defense), noiseSuppression OFF (Deepgram
      // counter-recommends it for streaming STT — it clips the first words of short
      // utterances like "vegetarian"), AGC on, mono.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: false,
          autoGainControl: true,
          channelCount: 1,
        },
      })
      streamRef.current = stream

      // Capture at 16 kHz so the BROWSER resamples (no hand-rolled decimation).
      const captureCtx = new AudioContext({ sampleRate: CAPTURE_SAMPLE_RATE })
      captureCtxRef.current = captureCtx
      await captureCtx.audioWorklet.addModule(WORKLET_URL)
      const source = captureCtx.createMediaStreamSource(stream)
      const worklet = new AudioWorkletNode(captureCtx, 'pcm-recorder')
      workletRef.current = worklet
      worklet.port.onmessage = (e: MessageEvent) => {
        const { audio, rms } = e.data as { audio: ArrayBuffer; rms: number }
        if (!activeRef.current) return
        // While muted we DON'T send real mic bytes (the server substitutes silence
        // on its side from the `mute` control frame), so nothing the member says
        // while muted reaches Flux. Read the live ref, not the captured `muted`.
        if (!mutedRef.current) socket.emit('voice:audio', audio)
        // Throttle amplitude state to ~10 Hz.
        const now = performance.now()
        if (now - lastAmpAtRef.current > 100) {
          lastAmpAtRef.current = now
          setAmplitude(mutedRef.current ? 0 : Math.min(1, rms * 4))
        }
      }
      source.connect(worklet)
      // Route the (silent) worklet output to the destination so the render graph
      // pulls it. process() never writes to its output, so this is silence — no
      // mic feedback into the speakers.
      worklet.connect(captureCtx.destination)

      // Playback context at Cartesia's native rate.
      playbackCtxRef.current = new AudioContext({ sampleRate: PLAYBACK_SAMPLE_RATE })
      nextStartRef.current = 0
      leftoverRef.current = new Uint8Array(0)

      activeRef.current = true
      mutedRef.current = false
      setListening(true)
      socket.emit('voice:start', { sessionId })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the microphone')
      stop()
    }
  }, [sessionId, stop])

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m
      mutedRef.current = next
      // Tell the server: while muted the client keeps streaming silence upstream so
      // Flux's ~60s idle-with-no-keepalive timeout never closes the stream. The
      // worklet keeps running; we just gate the real bytes in its onmessage.
      getSocket()?.emit('voice:control', { type: 'mute', muted: next })
      return next
    })
  }, [])

  const resetTranscript = useCallback(() => setTranscript(''), [])

  // Stop on unmount so a leaked mic never keeps a billed Flux socket open.
  useEffect(() => stop, [stop])

  return {
    supported:
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices &&
      typeof AudioWorkletNode !== 'undefined',
    listening,
    transcript,
    speaking,
    muted,
    amplitude,
    error,
    start: () => void start(),
    stop,
    toggleMute,
    resetTranscript,
  }
}
