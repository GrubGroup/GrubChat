import { create } from 'zustand'
import { DEFAULT_VOICE_ID, isKnownVoiceId } from '@/constants/voices'

// The user's chosen TTS voice for the hands-free session agent loop.
//
// Persisted to localStorage directly (no zustand `persist` middleware — nothing
// else in the app uses it, and the state here is a single string). This is a
// per-DEVICE preference: it is a voice-RENDERING choice, not dining data, so it
// lives client-side rather than in the `Profile` row that feeds the SQLModel
// mirror + recommendation pipeline. `useVoiceSession` reads `voiceId` when it
// seeds the `voice:start` frame, so the selection reaches Cartesia TTS.
const STORAGE_KEY = 'gg:voiceId'

// Read once at module load, tolerating a disabled/absent localStorage (SSR,
// privacy mode). An unknown/stale id resolves to the default.
function readStored(): string {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return isKnownVoiceId(raw) ? raw : DEFAULT_VOICE_ID
  } catch {
    return DEFAULT_VOICE_ID
  }
}

interface VoicePrefState {
  voiceId: string
  setVoiceId: (id: string) => void
}

export const useVoicePrefStore = create<VoicePrefState>((set) => ({
  voiceId: readStored(),
  setVoiceId: (id) => {
    if (!isKnownVoiceId(id)) return
    try {
      localStorage.setItem(STORAGE_KEY, id)
    } catch {
      /* storage unavailable — keep the in-memory choice for this session */
    }
    set({ voiceId: id })
  },
}))
