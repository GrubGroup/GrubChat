"""Verify the Stage 0b latency fixes preserved correctness (not just speed).

Stage 0b made three changes to get the conversational analyze turn from ~3.9 s
p50 to ~0.65 s, inside the ~700 ms real-time voice budget:

  1. Extraction routed to a fast provider/model pair (settings.extraction_*)
     instead of inheriting the strong ranking model.
  2. A delta-shaped response contract (PREFERENCE_TURN_DELTA_OVERRIDE): the model
     returns only CHANGED fields and no agent_reply; the server authors the reply.
  3. crud.session.get_analyze_context — the session + both Qa rows in ONE query
     instead of three sequential ones.

Speed is the easy part; each change has a way to be quietly wrong:
  * (2) risks losing unchanged fields if the delta merge does not carry them
    through, and risks breaking CORRECTIONS if removed_* lists stop arriving.
  * (2) also risks a degraded-path misread: an absent agent_reply is now EXPECTED,
    so it must not be reported as degradation.
  * (3) risks returning the wrong person's Qa row, or mis-resolving host identity.

This exercises those directly, against the live provider and the live database.

Run:
    cd backend/ai_service
    uv run python -m scripts.verify_stage0b
"""

from __future__ import annotations

import asyncio

from app.ai.agents.conversation_agent import analyze_turn
from app.core.config import settings
from app.crud import session as session_crud
from app.db.session import async_session_factory
from app.schemas.ai import ConversationTurn, ExtractedSignals

_passed = 0
_failed = 0


def _check(label: str, ok: bool, detail: str = "") -> None:
    global _passed, _failed
    mark = "PASS" if ok else "FAIL"
    if ok:
        _passed += 1
    else:
        _failed += 1
    suffix = f"   {detail}" if detail else ""
    print(f"    [{mark}] {label}{suffix}")


async def _test_carry_through() -> None:
    """A delta response must NOT drop fields the user didn't mention this turn."""
    print("\n  1. CARRY-THROUGH — unchanged fields survive a delta response")
    prior = ExtractedSignals(
        preferred_cuisines=["thai", "ramen"],
        disliked_cuisines=["german"],
        budget_max=40,
        dietary_restrictions=["vegetarian"],
    )
    # Speaks ONLY to location; everything else must be preserved untouched.
    result = await analyze_turn(
        "somewhere near the mission would be easier for me",
        current_signals=prior,
        message_source="voice",
        is_host=False,
    )
    s = result.signals
    _check("preferred_cuisines kept", set(prior.preferred_cuisines) <= set(s.preferred_cuisines), str(s.preferred_cuisines))
    _check("disliked_cuisines kept", "german" in s.disliked_cuisines, str(s.disliked_cuisines))
    _check("budget_max kept (40)", s.budget_max == 40, str(s.budget_max))
    _check("dietary kept", "vegetarian" in s.dietary_restrictions, str(s.dietary_restrictions))
    _check("location captured", bool(s.location_label or s.location_mode), f"{s.location_mode}/{s.location_label}")
    _check("not degraded", not result.degraded)
    _check("server authored a reply", bool(result.agent_reply.strip()), result.agent_reply[:70])


async def _test_correction() -> None:
    """Corrections must still drop the stale tag — the removed_* path."""
    print("\n  2. CORRECTION — stale value is dropped, not left behind")
    prior = ExtractedSignals(
        preferred_cuisines=["mexican"],
        disliked_cuisines=["chinese"],
        budget_max=30,
    )
    result = await analyze_turn(
        "actually I do like chinese, and drop the mexican",
        current_signals=prior,
        message_source="voice",
        is_host=False,
    )
    s = result.signals
    _check("chinese moved to preferred", "chinese" in s.preferred_cuisines, str(s.preferred_cuisines))
    _check("chinese no longer disliked", "chinese" not in s.disliked_cuisines, str(s.disliked_cuisines))
    _check("mexican dropped", "mexican" not in s.preferred_cuisines, str(s.preferred_cuisines))
    _check("budget untouched (30)", s.budget_max == 30, str(s.budget_max))


async def _test_arbitrary_wording() -> None:
    """The feature's whole point: loose phrasing still maps to taxonomy tags."""
    print("\n  3. ARBITRARY WORDING — the verbatim goal cases")
    r1 = await analyze_turn(
        "I'm not feeling greasy food and want lighter foods to eat",
        current_signals=ExtractedSignals(),
        message_source="voice",
    )
    _check(
        "greasy -> disliked tags",
        bool(r1.signals.disliked_cuisines),
        str(r1.signals.disliked_cuisines[:6]),
    )
    r2 = await analyze_turn(
        "I'm feeling like eating noodles but not sure what type",
        current_signals=ExtractedSignals(),
        message_source="voice",
    )
    _check(
        "noodles -> preferred tags",
        bool(r2.signals.preferred_cuisines),
        str(r2.signals.preferred_cuisines[:6]),
    )


async def _test_missing_signals_order() -> None:
    """The server-authored reply must follow the canonical ask-order."""
    print("\n  4. ASK-ORDER — server-authored question follows missing_signals")
    result = await analyze_turn(
        "I love thai food",
        current_signals=ExtractedSignals(),
        message_source="voice",
        is_host=False,
    )
    missing = result.missing_signals
    _check("missing_signals populated", bool(missing), str(missing))
    if missing:
        _check(
            "first missing is dislikes (likes answered)",
            missing[0] == "disliked_cuisines",
            f"first={missing[0]}",
        )
    _check("reply is non-empty", bool(result.agent_reply.strip()), result.agent_reply[:70])


async def _test_db_context() -> None:
    """get_analyze_context must return the right rows for the right people."""
    print("\n  5. DB — one-query context returns correct session/Qa rows")
    async with async_session_factory() as db:
        # Find a real session that has at least one Qa row to assert against.
        target = None
        for sid in range(1, 60):
            session = await session_crud.get_session(db, sid)
            if session is None:
                continue
            rows = await session_crud.list_qa(db, sid)
            if rows:
                target = (session, rows)
                break
        if target is None:
            _check("found a session with Qa rows", False, "none in range 1..60")
            return

        session, rows = target
        sid = session.id
        host_id = session.host_user_id
        member_row = next((r for r in rows if r.user_id != host_id), rows[0])

        # As the HOST.
        s_host, own_host, host_qa = await session_crud.get_analyze_context(db, sid, host_id)
        _check("host: session returned", s_host is not None and s_host.id == sid)
        _check(
            "host: own == host row",
            (own_host.user_id if own_host else None) == (host_qa.user_id if host_qa else None),
            f"own={own_host.user_id if own_host else None} host={host_qa.user_id if host_qa else None}",
        )

        # As a MEMBER — the caller's row must be theirs, not the host's.
        uid = member_row.user_id
        s_mem, own_mem, host_for_mem = await session_crud.get_analyze_context(db, sid, uid)
        _check("member: session returned", s_mem is not None and s_mem.id == sid)
        _check(
            "member: own row is the CALLER's",
            own_mem is not None and own_mem.user_id == uid,
            f"got user_id={own_mem.user_id if own_mem else None}, wanted {uid}",
        )
        if uid != host_id:
            _check(
                "member: host row is the HOST's",
                host_for_mem is None or host_for_mem.user_id == host_id,
                f"got user_id={host_for_mem.user_id if host_for_mem else None}",
            )

        # Cross-check against the old per-row accessor — same data, fewer queries.
        legacy = await session_crud.get_qa_for_user(db, sid, uid)
        _check(
            "matches get_qa_for_user",
            (legacy.id if legacy else None) == (own_mem.id if own_mem else None),
        )

        # A missing session must yield all-None rather than raising.
        s_none, a_none, b_none = await session_crud.get_analyze_context(db, 10**9, uid)
        _check("absent session -> (None, None, None)", (s_none, a_none, b_none) == (None, None, None))


async def _run() -> int:
    print("=" * 78)
    print("  Stage 0b verification — did the speedup preserve behavior?")
    print("=" * 78)
    print(f"  low_latency      : {settings.analyze_low_latency}")
    print(f"  extraction       : {settings.active_extraction_provider} / {settings.active_extraction_model}")
    print(f"  ranking (unchanged): {settings.llm_provider} / {settings.active_llm_model}")

    await _test_carry_through()
    await _test_correction()
    await _test_arbitrary_wording()
    await _test_missing_signals_order()
    await _test_db_context()

    print()
    print("=" * 78)
    total = _passed + _failed
    print(f"  {_passed}/{total} checks passed" + (f"  — {_failed} FAILED" if _failed else "  — all good"))
    return 1 if _failed else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_run()))
