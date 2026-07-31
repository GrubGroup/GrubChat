// Selectable TTS voices for the hands-free session agent loop.
//
// These are Cartesia voice IDs — the value flows browser → gateway → ai_service
// and is handed to `stream_audio(voice_id=...)` (backend/ai_service/app/ai/voice/
// tts.py). The SAME id list is mirrored server-side as an allowlist in
// `app/ai/voice/voices.py`; keep the two in sync (an id absent from the server
// allowlist silently falls back to the server default voice).
//
// The choice is a rendering preference (which voice the agent SPEAKS with), not
// dining data, so it is persisted client-side (see stores/voicePrefStore.ts) and
// deliberately kept out of the dietary `Profile` / recommendation pipeline.

export interface VoiceOption {
  id: string
  name: string
  gender: 'Male' | 'Female'
}

export const VOICE_OPTIONS: VoiceOption[] = [
  { id: 'a5136bf9-224c-4d76-b823-52bd5efcffcc', name: 'Jameson', gender: 'Male' },
  { id: '4f7f1324-1853-48a6-b294-4e78e8036a83', name: 'Casper', gender: 'Male' },
  { id: 'f039066f-cdb7-45ed-b51d-1034ae2f04a0', name: 'Cindy Baker', gender: 'Female' },
  { id: 'f9836c6e-a0bd-460e-9d3c-f7299fa60f94', name: 'Caroline', gender: 'Female' },
]

// First option is the default when nothing is stored yet.
export const DEFAULT_VOICE_ID = VOICE_OPTIONS[0].id

// Guard a stored/loaded id against the current option set — a value no longer on
// the list (removed voice, tampered storage) resolves to the default.
export function isKnownVoiceId(id: string | null | undefined): id is string {
  return !!id && VOICE_OPTIONS.some((v) => v.id === id)
}
