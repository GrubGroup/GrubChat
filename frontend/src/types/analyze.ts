// DTOs for the conversational QA sub-agent (analyze) round-trip and the host
// pre-session modal. These mirror the ai_service Pydantic schemas
// (backend/ai_service/app/schemas/ai.py) and the gateway controllers exactly so
// the request/response shapes line up end to end.

// The structured signal set the agent parses from one member turn. Mirrors
// ai_service `ExtractedSignals`. Every field is optional-ish (nullable) so a
// partial turn round-trips cleanly.
export interface ExtractedSignals {
  dietary_restrictions: string[]
  preferred_cuisines: string[]
  disliked_cuisines: string[]
  budget_min: number | null
  budget_max: number | null
  // Session-scoped Qa signals. occasion is host-only (dropped for non-hosts
  // server-side). The event TIME is NOT here — it lives on Session.scheduled_for.
  occasion: string | null
  location_mode: 'named' | 'realtime' | 'unset' | null
  location_label: string | null
  location_lat: number | null
  location_lon: number | null
  radius_miles: number | null
}

// One prior turn of the agent conversation, replayed for multi-turn context so
// corrections work (ai_service does not mirror a messages table).
export interface ConversationTurn {
  role: 'user' | 'assistant'
  content: string
}

// Request body for POST /api/sessions/:id/analyze. NOTE: `user_id` is NOT sent —
// the gateway injects the server-verified identity. `persist_profile` is ignored
// on an in-session turn (the sub-agent only writes the member's Qa row).
export interface AnalyzeTurnBody {
  message: string
  message_source?: 'voice' | 'text'
  conversation_history?: ConversationTurn[]
  current_signals?: Partial<ExtractedSignals>
}

// Response body for the analyze endpoint. Mirrors ai_service `AnalyzeResponse`:
// the reply text is `agent_reply` (not `reply`). Completion is the authoritative
// `is_complete` flag (server-derived from `missing_signals` being empty) — the
// frontend keys the "I'm Finished" CTA off it rather than re-deriving it.
export interface AnalyzeResponse {
  user_id: number
  session_id: number | null
  extracted_signals: ExtractedSignals
  profile_updated: boolean
  qa_updated: boolean
  agent_reply: string
  missing_signals: string[]
  // True once the agent has everything it needs for this member's role. Optional
  // on the wire so an older gateway/ai_service without the field degrades to the
  // missingSignals-empty inference in the store.
  is_complete?: boolean
}

// Request body for POST /api/sessions — the host pre-session modal answers.
// `scheduled_for` is an ISO string, or 'now' / omitted to stamp the current time.
export interface CreateSessionBody {
  group_id?: number | null
  time_limit: number
  occasion?: string | null
  scheduled_for?: string | 'now' | null
  location_address?: string | null
  // Coordinates from a picked Places suggestion. When present the gateway trusts
  // them and skips its own geocode; when null it geocodes location_address.
  location_lat?: number | null
  location_lon?: number | null
}

// A dining-history event as returned by GET /api/events (gateway `listEvents`).
// The frontend's live Events tab renders these. Distinct from the mock
// `EventLite` (presentation fixture) — this is the real API row shape.
export interface EventAttendee {
  id: number
  username: string
  display_name?: string | null
}

export interface EventRecord {
  id: number
  date: string
  address?: string | null
  lat?: number | null
  lon?: number | null
  restaurant_id: number
  restaurant_name: string
  occasion?: string | null
  time_slot?: string | null
  group_id?: number | null
  group_name?: string | null
  // Participants who attended the session this event came from (gateway
  // listEvents joins Event.attendees). Absent on legacy rows / mock fixtures
  // that don't supply it.
  attendees?: EventAttendee[]
}
