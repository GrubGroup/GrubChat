// Voice-session wire types + the controller contract VoiceComposer renders.
//
// Two layers here:
//   1. The downstream control frames the ai_service voice WS emits (relayed
//      verbatim by the gateway as `voice:frame`). These mirror
//      backend/ai_service/app/schemas/voice.py 1:1 so the union stays exhaustive.
//   2. `VoiceController` — the small surface VoiceComposer needs, so the component
//      is agnostic to whether it's driven by the Web Speech hook (useVoiceInput,
//      group chat) or the full session loop (useVoiceSession, agent chat).

import type { ExtractedSignals } from './analyze'

// ---- downstream control frames (ai_service -> gateway -> browser) -----------
// Delivered as the socket event `voice:frame` with one of these JSON payloads.

export interface VoiceReadyFrame {
  type: 'ready'
}
export interface VoiceCaptionFrame {
  type: 'caption'
  text: string
  is_final: boolean
}
export interface VoiceBargeInFrame {
  type: 'barge_in'
}
export interface VoiceTurnFinalFrame {
  type: 'turn_final'
  transcript: string
}
export interface VoiceTurnResultFrame {
  type: 'turn_result'
  extracted_signals: ExtractedSignals
  missing_signals: string[]
  agent_reply: string
  is_complete: boolean
  degraded: boolean
}
export interface VoiceSpeechEndFrame {
  type: 'speech_end'
}
export interface VoiceCompleteFrame {
  type: 'complete'
}
export interface VoiceErrorFrame {
  type: 'error'
  message: string
}

// Discriminated union over `type` — narrow on `frame.type` at the receive site.
export type VoiceFrame =
  | VoiceReadyFrame
  | VoiceCaptionFrame
  | VoiceBargeInFrame
  | VoiceTurnFinalFrame
  | VoiceTurnResultFrame
  | VoiceSpeechEndFrame
  | VoiceCompleteFrame
  | VoiceErrorFrame

// ---- upstream control frames (browser -> gateway -> ai_service) -------------
// Sent on the socket event `voice:control`.

export interface VoiceStartFrame {
  type: 'start'
  conversation_history: { role: 'user' | 'assistant'; content: string }[]
  current_signals: ExtractedSignals
}
export interface VoiceMuteFrame {
  type: 'mute'
  muted: boolean
}
export interface VoiceStopFrame {
  type: 'stop'
}
export type VoiceControlFrame = VoiceStartFrame | VoiceMuteFrame | VoiceStopFrame

// ---- the controller VoiceComposer consumes ---------------------------------
// A superset of what useVoiceInput already returns (supported/listening/
// transcript/start/stop/resetTranscript), plus the hands-free-loop fields
// useVoiceSession adds. The extra fields are OPTIONAL so the Web Speech hook (which
// lacks them) still satisfies the type at the group-chat call site.
export interface VoiceController {
  /** Whether voice input is available at all (drives the mic-button render). */
  supported: boolean
  /** The mic is capturing (Web Speech) or the hands-free loop is running. */
  listening: boolean
  /** Live transcript for the in-composer caption. */
  transcript: string
  /** Begin capture / start the hands-free loop. */
  start: () => void
  /** End capture / stop the loop. */
  stop: () => void
  /** Clear the current transcript (used between turns). */
  resetTranscript: () => void

  // --- hands-free-loop extras (useVoiceSession only) ---
  /** The agent is currently speaking (TTS playing) — lets the UI show a state. */
  speaking?: boolean
  /** Mic is muted (still streaming silence upstream to keep Flux alive). */
  muted?: boolean
  /** Toggle mute; no-op for the Web Speech controller. */
  toggleMute?: () => void
  /** 0..1 input level from the worklet RMS, for a real waveform. */
  amplitude?: number
  /** A non-fatal status/error to surface (e.g. "voice busy — showing text only"). */
  error?: string | null
}
