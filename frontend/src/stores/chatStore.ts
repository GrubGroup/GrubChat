import { create } from 'zustand'
import type { ChatMessage, ConversationTurn, ExtractedSignals } from '@/types'
import { openingAgentMessage } from '@/constants/agentChat'
import { analyzeTurn } from '@/api/sessionApi'

// The per-group agent-chat slice. Keyed by GROUP so two groups' transcripts
// coexist: entering group B no longer wipes group A's in-progress conversation,
// and returning to A shows it intact. Mirrors the keyed pattern of
// sessionStore/groupChatStore. (NotedSoFarPanel derives its rows directly from
// currentSignals + missingSignals, so there is no separate notedPreferences list.)
export interface ChatSlice {
  messages: ChatMessage[]
  // The session this transcript/signal-set belongs to. Used to re-seed when the
  // active session changes, so session B never inherits session A's chat.
  sessionId: number | null
  // The reconciled signal set the agent has accumulated across turns — sent back
  // on each turn so corrections work. Cuisines here are COMPACT (a broad answer is
  // the group key "asian"), which keeps the analyze turn fast and the spoken voice
  // reply short — do NOT render these in the panel directly.
  currentSignals: ExtractedSignals
  // DISPLAY-ONLY expanded cuisine lists for the "Noted so far" panel: the concrete
  // members a stored group key covers (asian -> chinese, japanese, ...), computed
  // by the backend with the SAME expansion the orchestrator ranks on. Kept
  // separate from currentSignals so expanding the panel never re-inflates what we
  // echo back to the LLM. Empty until the first analyze reply that carries them.
  displayPreferredCuisines: string[]
  displayDislikedCuisines: string[]
  missingSignals: string[]
  // Authoritative "the member has answered everything" flag, from the analyze
  // response's is_complete (fallback: missingSignals empty). Seeded false so it's
  // only true after a real turn — drives the agent-chat "All set" affordance.
  isComplete: boolean
  sending: boolean
}

// Declared BEFORE makeChatSlice: makeChatSlice() calls it, and EMPTY_CHAT_SLICE
// invokes makeChatSlice() at module-eval time — so emptySignals must already be
// initialized by then (a later `const` would throw a TDZ ReferenceError on import
// and blank the whole app).
const emptySignals = (): ExtractedSignals => ({
  dietary_restrictions: [],
  preferred_cuisines: [],
  disliked_cuisines: [],
  budget_min: null,
  budget_max: null,
  budget_flexible: null,
  occasion: null,
  location_mode: null,
  location_label: null,
  location_lat: null,
  location_lon: null,
  radius_miles: null,
})

const makeChatSlice = (): ChatSlice => ({
  messages: [],
  sessionId: null,
  currentSignals: emptySignals(),
  displayPreferredCuisines: [],
  displayDislikedCuisines: [],
  missingSignals: [],
  isComplete: false,
  sending: false,
})

// Stable frozen default returned by selectors for a group with no transcript yet,
// so an absent-group read never yields a fresh object (React 19 StrictMode loop).
const EMPTY_CHAT_SLICE: ChatSlice = Object.freeze(makeChatSlice())

interface ChatState {
  byGroup: Record<number, ChatSlice>
  // Reset the conversation for a group's (possibly new) session. Opens with a
  // single agent greeting that asks the first question (dietary); everything after
  // is agent-reply-driven by the analyze round-trip. Records the sessionId so the
  // page can detect a stale transcript and re-seed. `displayName` personalizes the
  // greeting ("Hi Dev!").
  seed: (groupId: number, sessionId?: number | null, displayName?: string | null) => void
  // Attach the now-known session id to a group's CURRENT transcript WITHOUT wiping
  // it. Used when the active session id resolves (null → concrete) after seed
  // already ran — so refining an unknown id into the real one never re-seeds and
  // drops an in-progress conversation (only a genuinely different session re-seeds).
  adoptSessionId: (groupId: number, sessionId: number) => void
  // Send one member turn to the QA sub-agent (analyze). Async: appends the user
  // message immediately, then the agent reply when it returns — always to the
  // ORIGIN group's slice, even if the user switched groups mid-round-trip.
  // `sessionId` is the live session; null falls back to the mock/canned path.
  // `source` ('voice' when dictated, 'text' when typed) rides through to the
  // analyze endpoint's `message_source`, which makes the model forgiving of
  // speech-to-text transcription noise.
  sendUserMessage: (
    groupId: number,
    text: string,
    sessionId: number | null,
    source?: 'voice' | 'text',
  ) => Promise<void>
  // --- voice hands-free loop ingestion ---
  // For a VOICE turn the analyze POST happens SERVER-SIDE (ai_service, via the WS
  // relay), so sendUserMessage — which does its own POST — can't be the ingestion
  // path. These two mirror the halves of sendUserMessage without the HTTP call:
  //
  // appendVoiceTranscript: the member's finalized spoken turn arrived (turn_final).
  // Append the user row and set sending:true. Returns false when a turn is already
  // in flight (sending) so the caller can drop/queue an overlapping hands-free
  // turn — the sole client-side turn serializer, which the voice path otherwise
  // bypasses (sendUserMessage's `cur.sending` re-entrancy guard never runs here).
  appendVoiceTranscript: (groupId: number, text: string) => boolean
  // applyVoiceTurn: the analyzed result arrived (turn_result). Append the agent row
  // and patch signals/missing/complete/sending — the SAME patch shape as the tail
  // of sendUserMessage, so NotedSoFarPanel and the "All set" banner light up
  // identically for a spoken turn.
  applyVoiceTurn: (
    groupId: number,
    result: {
      agent_reply: string
      extracted_signals: ExtractedSignals
      missing_signals: string[]
      is_complete?: boolean
      // Expanded cuisines for the panel (see ChatSlice.displayPreferredCuisines).
      display_preferred_cuisines?: string[]
      display_disliked_cuisines?: string[]
    },
  ) => void
  // A voice turn failed upstream (analyze error / relay drop). Clear `sending` and
  // surface an honest system notice, mirroring sendUserMessage's catch — WITHOUT
  // touching signals (the answer wasn't processed).
  failVoiceTurn: (groupId: number, message?: string) => void
}

let idCounter = 100
const nextId = () => `m${++idCounter}`

// Build the conversation_history the analyze endpoint replays for context, from
// the rendered messages (system lines dropped; agent -> assistant).
function toConversationHistory(messages: ChatMessage[]): ConversationTurn[] {
  return messages
    .filter((m) => m.role === 'user' || m.role === 'agent')
    .map((m) => ({ role: m.role === 'agent' ? 'assistant' : 'user', content: m.text }))
}

export const useChatStore = create<ChatState>((set, get) => {
  // Read a group's transcript slice (never mutate through this).
  const slice = (groupId: number): ChatSlice => get().byGroup[groupId] ?? EMPTY_CHAT_SLICE

  // Immutably patch ONE group's transcript, lazily seeding from makeChatSlice() so
  // a group's first write can't crash on an absent slice. Other groups untouched.
  const patchChat = (
    groupId: number,
    patchOrFn: Partial<ChatSlice> | ((prev: ChatSlice) => Partial<ChatSlice>),
  ) =>
    set((s) => {
      const prev = s.byGroup[groupId] ?? makeChatSlice()
      const next = typeof patchOrFn === 'function' ? patchOrFn(prev) : patchOrFn
      return { byGroup: { ...s.byGroup, [groupId]: { ...prev, ...next } } }
    })

  return {
    byGroup: {},

    seed: (groupId, sessionId = null, displayName = null) => {
      // The conversation always opens with the agent's greeting, which asks the
      // FIRST question (dietary). No canned user turn, no pre-filled noted prefs —
      // signals accumulate only from real analyze replies as the member answers.
      const opening: ChatMessage = {
        id: nextId(),
        role: 'agent',
        text: openingAgentMessage(displayName),
        at: new Date().toISOString(),
      }
      patchChat(groupId, {
        messages: [opening],
        sessionId,
        currentSignals: emptySignals(),
        displayPreferredCuisines: [],
        displayDislikedCuisines: [],
        missingSignals: [],
        isComplete: false,
      })
    },

    adoptSessionId: (groupId, sessionId) => {
      // Only stamp it on — never touch messages/signals. No-op if unchanged.
      if (slice(groupId).sessionId !== sessionId) patchChat(groupId, { sessionId })
    },

    sendUserMessage: async (groupId, text, sessionId, source = 'text') => {
      const cur = slice(groupId)
      const trimmed = text.trim()
      if (!trimmed || cur.sending) return

      const userMsg: ChatMessage = {
        id: nextId(),
        role: 'user',
        text: trimmed,
        at: new Date().toISOString(),
      }
      const history = toConversationHistory(cur.messages)
      patchChat(groupId, (prev) => ({ messages: [...prev.messages, userMsg], sending: true }))

      try {
        const res = await analyzeTurn(sessionId ?? 0, {
          message: trimmed,
          // Real source, not a constant: the backend prompt branches on this to
          // forgive transcription noise on dictated turns (prompts.py
          // MESSAGE_SOURCE), so hardcoding 'text' silently disabled that path.
          message_source: source,
          conversation_history: history,
          // Read the CURRENT signals for THIS group at send time (the slice may have
          // advanced since we captured `cur`); the origin group is fixed by groupId.
          current_signals: slice(groupId).currentSignals,
        })
        const agentMsg: ChatMessage = {
          id: nextId(),
          role: 'agent',
          text: res.agent_reply,
          at: new Date().toISOString(),
        }
        // Append to the ORIGIN group unconditionally — even if the user switched
        // groups while the analyze round-trip was in flight, the reply belongs here.
        patchChat(groupId, (prev) => ({
          messages: [...prev.messages, agentMsg],
          currentSignals: res.extracted_signals,
          // Panel shows the expanded members; fall back to the compact list for an
          // older backend that omits the display fields (never leave it empty when
          // a cuisine was captured).
          displayPreferredCuisines:
            res.display_preferred_cuisines ?? res.extracted_signals.preferred_cuisines,
          displayDislikedCuisines:
            res.display_disliked_cuisines ?? res.extracted_signals.disliked_cuisines,
          missingSignals: res.missing_signals,
          // Prefer the server's authoritative flag; fall back to the missing list
          // being empty for an older gateway/ai_service that omits is_complete.
          isComplete: res.is_complete ?? res.missing_signals.length === 0,
          sending: false,
        }))
      } catch {
        // The analyze round-trip failed (network / gateway / ai_service / LLM). Keep
        // the prior signals untouched — the answer wasn't processed — and surface an
        // HONEST error rather than a fake agent acknowledgement. A `system` line
        // renders as a distinct centered notice (ChatMessage), so it's visibly an
        // error, NOT the agent moving on; and system lines are excluded from
        // toConversationHistory, so a retry re-asks the SAME question cleanly instead
        // of appearing to have been answered. Composer re-enables (sending:false).
        const errorNotice: ChatMessage = {
          id: nextId(),
          role: 'system',
          text: "Couldn't reach your food agent. Check your connection and try again.",
          at: new Date().toISOString(),
        }
        patchChat(groupId, (prev) => ({ messages: [...prev.messages, errorNotice], sending: false }))
      }
    },

    appendVoiceTranscript: (groupId, text) => {
      const cur = slice(groupId)
      const trimmed = text.trim()
      // Same guard sendUserMessage uses: refuse an empty turn or one while another
      // is already in flight. The WS loop serializes turns server-side too, but a
      // barge-in retranscription can still arrive fast — drop it here so two agent
      // replies never interleave in the transcript.
      if (!trimmed || cur.sending) return false
      const userMsg: ChatMessage = {
        id: nextId(),
        role: 'user',
        text: trimmed,
        at: new Date().toISOString(),
      }
      patchChat(groupId, (prev) => ({ messages: [...prev.messages, userMsg], sending: true }))
      return true
    },

    applyVoiceTurn: (groupId, result) => {
      const agentMsg: ChatMessage = {
        id: nextId(),
        role: 'agent',
        text: result.agent_reply,
        at: new Date().toISOString(),
      }
      patchChat(groupId, (prev) => ({
        messages: [...prev.messages, agentMsg],
        currentSignals: result.extracted_signals,
        // Expanded members for the panel; same compact-list fallback as the text
        // path so an older ai_service still populates the panel.
        displayPreferredCuisines:
          result.display_preferred_cuisines ?? result.extracted_signals.preferred_cuisines,
        displayDislikedCuisines:
          result.display_disliked_cuisines ?? result.extracted_signals.disliked_cuisines,
        missingSignals: result.missing_signals,
        // Same precedence as the text path: prefer the server flag, else infer from
        // an empty missing list. (turn_result always carries is_complete, but keep
        // the fallback so both ingestion paths read identically.)
        isComplete: result.is_complete ?? result.missing_signals.length === 0,
        sending: false,
      }))
    },

    failVoiceTurn: (groupId, message) => {
      const errorNotice: ChatMessage = {
        id: nextId(),
        role: 'system',
        text: message ?? "Couldn't reach your food agent. Check your connection and try again.",
        at: new Date().toISOString(),
      }
      // Clear `sending` and leave signals untouched — same as sendUserMessage's catch.
      patchChat(groupId, (prev) => ({ messages: [...prev.messages, errorNotice], sending: false }))
    },
  }
})

// Selectors — parameterized by group, StrictMode-safe stable EMPTY fallback.
export const selectChatMessages = (groupId: number) => (s: ChatState) =>
  (s.byGroup[groupId] ?? EMPTY_CHAT_SLICE).messages
export const selectChatSessionId = (groupId: number) => (s: ChatState) =>
  (s.byGroup[groupId] ?? EMPTY_CHAT_SLICE).sessionId
export const selectSending = (groupId: number) => (s: ChatState) =>
  (s.byGroup[groupId] ?? EMPTY_CHAT_SLICE).sending
export const selectMissingSignals = (groupId: number) => (s: ChatState) =>
  (s.byGroup[groupId] ?? EMPTY_CHAT_SLICE).missingSignals
export const selectCurrentSignals = (groupId: number) => (s: ChatState) =>
  (s.byGroup[groupId] ?? EMPTY_CHAT_SLICE).currentSignals
// The panel's cuisine chips: expanded members (asian -> chinese, japanese, ...),
// NOT the compact currentSignals form the LLM round-trips.
export const selectDisplayPreferredCuisines = (groupId: number) => (s: ChatState) =>
  (s.byGroup[groupId] ?? EMPTY_CHAT_SLICE).displayPreferredCuisines
export const selectDisplayDislikedCuisines = (groupId: number) => (s: ChatState) =>
  (s.byGroup[groupId] ?? EMPTY_CHAT_SLICE).displayDislikedCuisines
export const selectIsComplete = (groupId: number) => (s: ChatState) =>
  (s.byGroup[groupId] ?? EMPTY_CHAT_SLICE).isComplete
