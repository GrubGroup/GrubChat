"""Pydantic DTOs for AI endpoints (no table backing)."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class EmbedRequest(BaseModel):
    """Request body for POST /api/v1/embed."""

    text: str


class EmbedResponse(BaseModel):
    """Response body for POST /api/v1/embed: a 1024-dim embedding vector."""

    embedding: list[float]


class RecommendationRequest(BaseModel):
    """Request body for POST /api/v1/sessions/{session_id}/recommendations."""

    force_partial: bool = False


class RecommendationItemOut(BaseModel):
    """A single ranked restaurant pick within a recommendation.

    The persisted RecommendationItem row carries only restaurant_id / match_score
    / justification; `name`, `hours`, and `is_open` are enriched from the pipeline
    candidates so the picks payload is self-contained (e.g. when delivered into
    the group chat). `is_open` is the venue's open/closed status at the session's
    chosen event time — None when no time was set (unknown, not filtered).
    """

    restaurant_id: int
    match_score: float | None
    justification: str | None
    name: str | None = None
    hours: str | None = None
    is_open: bool | None = None


class RecommendationOut(BaseModel):
    """Response body: a persisted group recommendation with its ranked items."""

    id: int
    session_id: int
    created_at: datetime
    items: list[RecommendationItemOut]


# --- Conversational preference analyze (per-member QA sub-agent) --------------
# DTOs for the LLM-based turn parse endpoint. Field shapes intentionally line up
# with app/ai/graph/state.py (MemberPref + QaSignals) and the real Profile / Qa
# columns so extracted signals feed the orchestrator pipeline unchanged. This is
# the snake_case adaptation of the proposal's POST /ai/analyze sketch
# (planning/project_proposal.md).


class ConversationTurn(BaseModel):
    """One prior turn of the agent conversation, passed in for multi-turn context.

    History is supplied by the caller (the gateway) — ai_service does NOT mirror
    a messages table, so the correction flow works by replaying prior turns.
    """

    role: Literal["user", "assistant"]
    content: str


class ExtractedSignals(BaseModel):
    """The structured signal set parsed from one user turn.

    Durable per-user prefs (the Profile-backed fields) and session-scoped Qa
    signals travel together here; the service splits them to the right table.
    Every field is optional/defaulted so a partial turn (e.g. only a budget)
    round-trips cleanly and a correction can null nothing it didn't mention.
    """

    # Profile-backed durable preferences (MemberPref shape).
    dietary_restrictions: list[str] = Field(default_factory=list)
    preferred_cuisines: list[str] = Field(default_factory=list)
    disliked_cuisines: list[str] = Field(default_factory=list)
    budget_min: int | None = None
    budget_max: int | None = None
    # Session-scoped Qa signals (QaSignals shape). occasion is host-only; the
    # host's event TIME is no longer a signal here — it lives on
    # Session.scheduled_for (set in the pre-session modal, not the chat turn).
    occasion: str | None = None
    location_mode: Literal["named", "realtime", "unset"] | None = None
    location_label: str | None = None
    location_lat: float | None = None
    location_lon: float | None = None
    radius_miles: float | None = None


class AnalyzeRequest(BaseModel):
    """Request body for POST /api/v1/sessions/{session_id}/analyze (and profile-edit).

    Mirrors the proposal's `POST /ai/analyze`: the raw user message plus enough
    context (prior turns + already-known signals) for the LLM to reconcile a new
    message against what was said before — this is what makes corrections work.
    `session_id` is also taken from the path; a null value here marks a
    profile-edit turn outside any session (Qa is then skipped).
    """

    user_id: int
    message: str
    message_source: Literal["voice", "text"] = "text"
    conversation_history: list[ConversationTurn] = Field(default_factory=list)
    # Previously-extracted / stored signals to reconcile the new turn against.
    current_signals: ExtractedSignals = Field(default_factory=ExtractedSignals)
    # Only consulted on a PROFILE-EDIT turn (session_id is None): if true,
    # ai_service persists the durable Profile diff itself. On an IN-SESSION turn
    # this flag is IGNORED — the sub-agent never writes the Profile; it writes
    # only the member's session-scoped Qa row (their temporary override), and
    # reads the Profile solely as the fallback for fields the member didn't
    # override. This is what keeps a session's answers from mutating saved prefs.
    persist_profile: bool = True


class AnalyzeResponse(BaseModel):
    """Response body: reconciled signals + agent reply + what's still missing.

    Always populated even when persistence is deferred, so the endpoint is
    useful whether ai_service or the gateway ends up writing the rows.
    """

    user_id: int
    session_id: int | None
    extracted_signals: ExtractedSignals
    profile_updated: bool
    qa_updated: bool
    agent_reply: str
    missing_signals: list[str] = Field(default_factory=list)
    # DISPLAY-ONLY expansion of the cuisine lists, for the "Noted so far" panel.
    # `extracted_signals` stays COMPACT — a broad answer is stored/echoed as its
    # group key ("asian"), which keeps the analyze turn's output small (the voice
    # latency fix) and the spoken reply short. But the UI wants to SHOW the diner
    # the concrete cuisines a group covers (asian -> chinese, japanese, ...), which
    # is also exactly what the orchestrator ranks on. So we expand here with the
    # SAME expand_cuisine_terms the orchestrator uses (single source of truth, no
    # frontend taxonomy copy) and ship it alongside. Ambiguous free-text answers
    # ("noodles", "greasy food") have no group and pass through unchanged.
    display_preferred_cuisines: list[str] = Field(default_factory=list)
    display_disliked_cuisines: list[str] = Field(default_factory=list)
