"""Data access for sessions and session members."""

from collections.abc import Sequence
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.models.profile import Profile
from app.models.qa import Qa
from app.models.session import Session
from app.models.session_member import SessionMember


async def get_session(db: AsyncSession, session_id: int) -> Session | None:
    """Return a session by id, or None."""
    return await db.get(Session, session_id)


async def list_members(db: AsyncSession, session_id: int) -> list[SessionMember]:
    """Return all member rows for a session."""
    result = await db.execute(
        select(SessionMember).where(SessionMember.session_id == session_id)
    )
    return list(result.scalars().all())


async def get_profiles_for_users(
    db: AsyncSession, user_ids: Sequence[int]
) -> list[Profile]:
    """Return profile rows for the given user ids."""
    if not user_ids:
        return []
    result = await db.execute(
        select(Profile).where(Profile.user_id.in_(user_ids))
    )
    return list(result.scalars().all())


async def get_qa_for_user(
    db: AsyncSession, session_id: int, user_id: int
) -> Qa | None:
    """Return this member's Qa row for a session, or None.

    Qa is one row per (session, member) — keyed by the Prisma
    ``@@unique([session_id, user_id])`` — so this is the get-or-create key used
    by the per-member analyze flow.
    """
    result = await db.execute(
        select(Qa).where(Qa.session_id == session_id, Qa.user_id == user_id)
    )
    return result.scalars().first()


async def get_analyze_context(
    db: AsyncSession, session_id: int, user_id: int
) -> tuple[Session | None, Qa | None, Qa | None]:
    """Load everything one analyze turn needs, in ONE round-trip.

    Returns (session, caller's Qa, host's Qa). The analyze path previously issued
    three SEQUENTIAL queries (get_session, then the host's Qa, then the caller's
    Qa). Against the remote Render database each round-trip is ~120 ms, so that
    cost ~385 ms before the LLM call even started — over half of a real-time voice
    turn's total budget. One query with an OR over the two user ids collapses it
    to a single ~120 ms hop.

    The host's Qa is returned even when the caller IS the host (then both tuple
    slots reference the same row); resolving who is host stays with the caller,
    which keeps this function a pure read.
    """
    session = await db.get(Session, session_id)
    if session is None:
        return None, None, None

    # One statement, both rows: the caller's and the host's. When the caller is
    # the host these coincide and the query simply returns a single row.
    result = await db.execute(
        select(Qa).where(
            Qa.session_id == session_id,
            Qa.user_id.in_({user_id, session.host_user_id}),  # type: ignore[attr-defined]
        )
    )
    rows = list(result.scalars().all())
    by_user = {row.user_id: row for row in rows}
    return session, by_user.get(user_id), by_user.get(session.host_user_id)


async def list_qa(db: AsyncSession, session_id: int) -> list[Qa]:
    """Return every member's Qa row for a session (one per member)."""
    result = await db.execute(
        select(Qa).where(Qa.session_id == session_id).order_by(Qa.user_id)
    )
    return list(result.scalars().all())


async def all_members_confirmed(db: AsyncSession, session_id: int) -> bool:
    """Return True if the session has members and every one has status True."""
    members = await list_members(db, session_id)
    if not members:
        return False
    return all(member.status for member in members)


# Session-scoped Qa columns the conversational analyze flow may update.
_QA_UPDATABLE_FIELDS = (
    "preferred_cuisines",
    "disliked_cuisines",
    "occasion",
    "location_mode",
    "location_address",
    "location_lat",
    "location_lon",
    "radius_miles",
    "budget_min",
    "budget_max",
)

# Qa columns only the session host may set (the event's occasion). A non-host
# member's turn never writes these, even if the LLM extracted them. The event
# TIME is no longer a Qa field — it lives on Session.scheduled_for.
_QA_HOST_ONLY_FIELDS = ("occasion",)


async def upsert_qa_signals(
    db: AsyncSession,
    session_id: int,
    user_id: int,
    signals: dict[str, Any],
    *,
    is_host: bool = False,
) -> Qa:
    """Write one member's session-scoped signals onto their Qa row (get-or-create).

    Qa is one row per (session, member): this reuses get_qa_for_user to find the
    caller's row and creates one (session_id + user_id) when absent — every
    signal column is nullable. Only keys present in `signals` with a non-None
    value are written, so a partial turn never clears a previously-captured Qa
    field. `occasion` is HOST-ONLY: when `is_host` is False it is dropped here as
    a data-layer backstop, even if an earlier layer let it through. Mirrors the
    commit/refresh pattern in crud/recommendation.py — no
    DDL, just inserts/updates a Prisma-owned table like the Recommendation writes.
    """
    qa = await get_qa_for_user(db, session_id, user_id)
    if qa is None:
        qa = Qa(session_id=session_id, user_id=user_id)

    for field in _QA_UPDATABLE_FIELDS:
        if not is_host and field in _QA_HOST_ONLY_FIELDS:
            continue
        if field in signals and signals[field] is not None:
            setattr(qa, field, signals[field])

    db.add(qa)
    await db.commit()
    await db.refresh(qa)
    return qa
