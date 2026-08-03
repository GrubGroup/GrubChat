// The per-member preference sub-agent conversation, mirrored from the backend.
//
// This is the browser-side twin of `ai_service` `scripts/interactive_session.py`
// (`_QUESTIONS`) and `conversation_agent._MISSING_ORDER`: the sub-agent walks a
// diner through likes → dislikes → budget → location, one question at a time.
// The HOST is NOT asked for a location (they set the group location in the
// pre-session modal), so their flow is likes → dislikes → budget, mirroring
// `conversation_agent._ask_order(is_host)`.
// Dietary needs are NOT asked here — they're captured once in onboarding
// (`Profile.dietary_restrictions`) and feed the ranking hard-filter directly, so
// the session chat never re-asks them. The event's occasion and time are also NOT
// asked here — the host sets those once in the pre-session modal
// (`HostSessionModal`), so the chat never touches them for host or member alike.
//
// `AGENT_ASK_ORDER` is the exact signal-name vocabulary the analyze endpoint
// returns in `missing_signals`, so the UI can key chips / the "current question"
// off it directly.

// Signal names in ask-order — identical to the backend's `_MISSING_ORDER`.
export const AGENT_ASK_ORDER = [
  "preferred_cuisines",
  "disliked_cuisines",
  "budget",
  "location",
] as const;

export type AgentSignalName = (typeof AGENT_ASK_ORDER)[number];

// The agent's opening line — asks the FIRST question (preferred cuisines). The
// rest of the conversation is agent-reply-driven (each analyze reply confirms what
// it captured and asks the next missing question), so this is the only line the
// client seeds; everything after it comes from the analyze round-trip.
export function openingAgentMessage(name?: string | null): string {
  const who = name?.trim() ? name.trim().split(" ")[0] : "there";
  return (
    `Hi ${who}! I'm your food agent for this session. ` +
    `First, what sounds good today? A cuisine, a vibe, or a kind of spot.`
  );
}

// Quick-reply chips per question, keyed by the signal the agent is currently
// asking about. Mirrors the `chips` in `interactive_session.py`'s `_QUESTIONS`.
export const AGENT_CHIPS: Record<AgentSignalName, string[]> = {
  preferred_cuisines: ["Asian", "Italian", "Anything works"],
  disliked_cuisines: ["No steakhouses", "Nothing fancy", "Nothing to avoid"],
  budget: ["$15–20", "Under $20", "$20–40", "I'm flexible"],
  location: ["Near the Mission", "Downtown's fine", "Wherever works"],
};

// Chips for the current turn: driven by the first still-missing signal (the
// question the agent just asked). Empty once nothing is missing.
export function chipsForMissing(missing: string[]): string[] {
  const next = missing.find((m): m is AgentSignalName => m in AGENT_CHIPS);
  return next ? AGENT_CHIPS[next] : [];
}
