"""Merge extracted signals into persisted preferences."""

from __future__ import annotations

from app.ai.budget import is_no_cap
from app.crud import session as session_crud
from app.crud import user as user_crud
from app.db.session import async_session_factory
from app.schemas.ai import ExtractedSignals
from app.services.geocode import geocode

# Which ExtractedSignals fields are durable per-user prefs (-> Profile) vs
# session-scoped signals (-> Qa). The split mirrors the two tables the
# orchestrator reads (MemberPref columns live on Profile; QaSignals on Qa).
_PROFILE_LIST_FIELDS = (
    "dietary_restrictions",
    "preferred_cuisines",
    "disliked_cuisines",
)
_PROFILE_SCALAR_FIELDS = ("budget_min", "budget_max")
# Session-scoped Qa fields. Cuisines live here too: on a SESSION turn the
# extracted cuisines are the member's temporary override and are written to
# their Qa row (the Profile is deliberately not touched — see
# session_service.analyze_member_turn). occasion is carried through but
# host-gated at the CRUD layer, so a non-host's value is dropped there. The event
# time is no longer a Qa field — it lives on Session.scheduled_for.
_QA_LIST_FIELDS = (
    "preferred_cuisines",
    "disliked_cuisines",
)
_QA_FIELDS = (
    "preferred_cuisines",
    "disliked_cuisines",
    "occasion",
    "location_mode",
    "location_lat",
    "location_lon",
    "radius_miles",
    "budget_min",
    "budget_max",
)


def profile_diff(signals: ExtractedSignals) -> dict:
    """Extract the durable Profile-bound fields from a signal set.

    Lists are always included (they carry the full reconciled list, so a
    correction that dropped a tag is represented). Scalars are included only when
    set, so an unspoken budget never overwrites a stored one.

    The NO_CAP budget sentinel is deliberately NOT written to the Profile. "I'm
    flexible" is a SESSION-scoped answer (it lives on the Qa row), and
    Profile.budget_min/budget_max are non-null Ints that both band pickers
    round-trip by exact (min, max) tuple equality — so a durable {0, 0} written
    from one chat sentence would be a one-way door the profile editor could not
    undo. Both bounds are skipped TOGETHER so a partial write can never leave
    min > max. Keyed on the stored number rather than the derived
    `budget_flexible` flag, which a degraded turn can leave null.

    (In-session turns never reach here at all — analyze_member_turn only calls
    persist_qa. This guards the profile-EDIT turn, where session_id is None.)
    """
    diff: dict = {}
    for field in _PROFILE_LIST_FIELDS:
        diff[field] = list(getattr(signals, field) or [])
    if not is_no_cap(signals.budget_max):
        for field in _PROFILE_SCALAR_FIELDS:
            value = getattr(signals, field)
            if value is not None:
                diff[field] = value
    return diff


def qa_diff(signals: ExtractedSignals) -> dict:
    """Extract the session-scoped Qa-bound fields from a signal set.

    Cuisine lists carry the FULL reconciled list (so a correction that dropped a
    tag is represented), matching profile_diff's list handling. Scalars are
    included only when set, so an unspoken budget/location never overwrites a
    stored one. Host-only occasion passes through here; the CRUD layer drops it
    for a non-host.

    The NO_CAP budget sentinel needs no special case: it is 0, which passes the
    `is not None` test here and in crud.session.upsert_qa_signals, so "I'm
    flexible" persists on the member's Qa row through the ordinary plumbing —
    unlike a NULL, which both layers skip and which would be indistinguishable
    from "not answered yet".
    """
    diff: dict = {}
    for field in _QA_LIST_FIELDS:
        diff[field] = list(getattr(signals, field) or [])
    for field in _QA_FIELDS:
        if field in _QA_LIST_FIELDS:
            continue
        value = getattr(signals, field)
        if value is not None:
            diff[field] = value
    return diff


async def persist_profile(user_id: int, signals: ExtractedSignals) -> bool:
    """Merge durable signals into the user's Profile row; return True if written.

    Returns False when the user has no Profile row yet — ai_service does not
    create Profiles (the gateway/Better-Auth path owns that). The caller still
    returns the diff in the response so the gateway can persist it.
    """
    diff = profile_diff(signals)
    async with async_session_factory() as db:
        profile = await user_crud.upsert_profile_signals(db, user_id, diff)
    return profile is not None


async def persist_qa(
    session_id: int,
    user_id: int,
    signals: ExtractedSignals,
    *,
    is_host: bool = False,
) -> bool:
    """Write this member's session-scoped signals onto their Qa row; return True.

    Always writes (get-or-create per (session, member)): a session turn's Qa
    snapshot is AI-produced, session-lifecycle data — the same ownership footing
    as the Recommendation rows ai_service already writes. `is_host` gates the
    host-only occasion field at the CRUD layer.

    When the LLM extracted a named location (``location_label``) we persist it as
    ``location_address`` and geocode it into coordinates — unless the turn already
    carried explicit coords (LLM- or client-provided), which take precedence. A
    geocode miss/outage leaves lat/lon out of the diff (upsert skips None), so the
    address text is stored with null coords rather than blocking the write.
    """
    diff = qa_diff(signals)
    if signals.location_label:
        diff["location_address"] = signals.location_label
        if "location_lat" not in diff:
            coords = await geocode(signals.location_label)
            if coords is not None:
                diff["location_lat"], diff["location_lon"] = coords

    async with async_session_factory() as db:
        await session_crud.upsert_qa_signals(
            db, session_id, user_id, diff, is_host=is_host
        )
    return True
