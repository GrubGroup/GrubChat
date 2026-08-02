"""Session create/join and status transitions."""

from __future__ import annotations

from typing import Any

from app.ai.agents.conversation_agent import (
    analyze_turn,
    apply_profile_cuisine_fallback,
)
from app.ai.taxonomy import expand_cuisine_terms
from app.crud import session as session_crud
from app.crud import user as user_crud
from app.db.session import async_session_factory
from app.models.qa import Qa
from app.schemas.ai import AnalyzeRequest, ExtractedSignals
from app.services import profile_service


def _merge_prior_qa(
    request_signals: ExtractedSignals | None, qa: Qa | None
) -> ExtractedSignals | None:
    """Merge the caller's ALREADY-STORED Qa row UNDER the request's signals.

    The frontend starts each session's ``current_signals`` empty, so without this
    the conversational agent never sees what the caller already set (most visibly
    the HOST's modal-chosen location, seeded onto their Qa row) and re-asks for it.
    We seed from the stored Qa row, then let the request's non-empty fields win —
    so an in-conversation correction still overrides the stored value, while
    fields the empty client body left null (location, budget, cuisines) are
    back-filled from the row. ``occasion`` is deliberately NOT surfaced: it's a
    pre-session-modal field the chat never touches.
    """
    if qa is None:
        return request_signals
    req = request_signals or ExtractedSignals()

    # Base = the stored Qa row mapped onto ExtractedSignals fields (names line up;
    # Qa.location_address -> location_label for the frontend geocode round-trip).
    merged = ExtractedSignals(
        # Carry durable-shaped fields the request already holds (dietary lives on
        # Profile, not Qa, so it only comes from the request).
        dietary_restrictions=list(req.dietary_restrictions),
        preferred_cuisines=(
            req.preferred_cuisines or list(qa.preferred_cuisines or [])
        ),
        disliked_cuisines=(
            req.disliked_cuisines or list(qa.disliked_cuisines or [])
        ),
        budget_min=req.budget_min if req.budget_min is not None else qa.budget_min,
        budget_max=req.budget_max if req.budget_max is not None else qa.budget_max,
        location_mode=req.location_mode or qa.location_mode,  # type: ignore[arg-type]
        location_label=req.location_label or qa.location_address,
        location_lat=(
            req.location_lat if req.location_lat is not None else qa.location_lat
        ),
        location_lon=(
            req.location_lon if req.location_lon is not None else qa.location_lon
        ),
        radius_miles=(
            req.radius_miles if req.radius_miles is not None else qa.radius_miles
        ),
    )
    return merged


async def analyze_member_turn(
    payload: AnalyzeRequest, *, session_id: int | None
) -> dict[str, Any]:
    """Parse one QA sub-agent turn, reconcile, persist per ownership rules, return.

    Workflow (mirrors recommendation_service's load -> compute -> persist shape):
      1. Resolve the caller's role for this session: is_host = (the session's
         host_user_id == payload.user_id). Only the host may set the event-level
         occasion; a member's turn never captures or writes it.
      2. Run the conversational agent (LLM parse + reconcile against prior
         signals; graceful degradation is handled inside analyze_turn), passing
         is_host so it asks the host-only questions of the host alone.
      3. IN A SESSION (session_id present): persist ONLY the member's session-
         scoped Qa row (their temporary override for this event) — the durable
         Profile is deliberately NOT written, so a session's answers never mutate
         a user's saved preferences. The Profile is read elsewhere (the pipeline)
         purely as the fallback when the member did not override a field.
      4. OUTSIDE A SESSION (session_id is None — the /analyze profile-edit turn):
         no Qa exists, so persist the durable Profile diff when
         payload.persist_profile is set. This keeps the profile-editor path
         working while the in-session sub-agent stays read-only on Profile.
      5. Return the full DTO-ready dict — extracted_signals + reply + missing +
         what was actually written — regardless of whether persistence ran.

    The returned dict maps 1:1 onto schemas.ai.AnalyzeResponse.
    """
    # Resolve host role from the DB (never trust a client-supplied flag). Only a
    # real session with a matching host_user_id makes this member the host. Also
    # read the host's chosen location so a NON-host member's agent can frame its
    # location question relative to it ("the host set downtown SF — want a spot
    # closer to you?").
    is_host = False
    host_location_label: str | None = None
    current_signals = payload.current_signals
    if session_id is not None:
        async with async_session_factory() as db:
            # One round-trip for the session + both Qa rows. This used to be three
            # sequential queries, which cost ~385 ms against the remote database —
            # more than half a real-time voice turn's budget before any LLM work.
            session, own_qa, host_qa = await session_crud.get_analyze_context(
                db, session_id, payload.user_id
            )
            if session is not None:
                if session.host_user_id == payload.user_id:
                    is_host = True
                elif host_qa is not None:
                    host_location_label = host_qa.location_address
            # Seed the agent with what the CALLER already set this session (their
            # own Qa row). The frontend sends empty current_signals each session,
            # so without this the host's modal-set location (and any prior answers)
            # are invisible and get re-asked. Request fields still win over stored.
            current_signals = _merge_prior_qa(payload.current_signals, own_qa)

    result = await analyze_turn(
        payload.message,
        current_signals=current_signals,
        message_source=payload.message_source,
        conversation_history=payload.conversation_history,
        is_host=is_host,
        host_location_label=host_location_label,
    )

    # "Anything works" -> acknowledge their saved cuisines. When the member
    # expressed no cuisine preference and none was captured, analyze_turn flags
    # this instead of looping. We resolve it here (I/O stays out of the agent):
    # read their durable Profile favorites so the reply can confirm we're falling
    # back to them ("I'll go with your usual ..."), so a flexible member never has
    # to re-state a cuisine every session. This does NOT persist a Qa override —
    # the pipeline already weights the durable Profile at +1, and stacking the +2
    # session weight would over-represent a member who declined to choose. Lazy on
    # purpose — the extra read only happens on the flexible turn, not every turn.
    if result.wants_profile_cuisines and session_id is not None:
        async with async_session_factory() as db:
            profile = await user_crud.get_profile_by_user(db, payload.user_id)
        saved_cuisines = list(profile.preferred_cuisines) if profile else []
        if saved_cuisines:
            apply_profile_cuisine_fallback(result, saved_cuisines)

    qa_updated = False
    profile_updated = False
    if session_id is not None:
        # In-session turn: write ONLY the member's Qa override; never the Profile.
        qa_updated = await profile_service.persist_qa(
            session_id, payload.user_id, result.signals, is_host=is_host
        )
    elif payload.persist_profile:
        # Profile-edit turn outside any session: durable Profile write is allowed.
        profile_updated = await profile_service.persist_profile(
            payload.user_id, result.signals
        )

    return {
        "user_id": payload.user_id,
        "session_id": session_id,
        "extracted_signals": result.signals,
        "profile_updated": profile_updated,
        "qa_updated": qa_updated,
        "agent_reply": result.agent_reply,
        "missing_signals": result.missing_signals,
        # Expand the COMPACT stored cuisines for the UI panel only (see
        # AnalyzeResponse) — the same expansion the orchestrator ranks on, so what
        # the diner sees under "Noted so far" is exactly what the search will use.
        "display_preferred_cuisines": expand_cuisine_terms(
            result.signals.preferred_cuisines
        ),
        "display_disliked_cuisines": expand_cuisine_terms(
            result.signals.disliked_cuisines
        ),
        # Surfaced for the voice loop, which must not auto-advance / mark complete
        # on a degraded (LLM-unusable) turn. Harmless to the HTTP path:
        # AnalyzeResponse has no such field and pydantic ignores the extra key.
        "degraded": result.degraded,
    }
