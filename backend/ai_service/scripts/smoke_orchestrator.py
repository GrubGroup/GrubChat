"""End-to-end smoke test: seed -> throwaway multi-member session -> orchestrate -> cleanup."""

from __future__ import annotations

import asyncio
from datetime import datetime

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.core.config import settings
from app.crud import restaurant as restaurant_crud
from app.db.session import async_session_factory
from app.models.group import Group
from app.models.profile import Profile
from app.models.qa import Qa
from app.models.session import Session
from app.models.session_member import SessionMember
from app.models.user import User
from app.services.recommendation_service import (
    SessionNotReadyError,
    generate_recommendation,
)

# Fixed run tag (no random / no time) so throwaway rows are deterministic and
# any leftover from a crashed run is overwritten/cleaned on the next pass.
_RUN_TAG = "smoke"

# Three deliberately DIVERGENT members: a strict vegan, a budget-tight eater,
# and an omnivore who dislikes what the others prefer. This forces the
# orchestrator's reconcile step (dietary union, budget-min cap, cuisine weights)
# to actually do work rather than trivially agree.
_MEMBERS = [
    {
        "username": f"{_RUN_TAG}_alice",
        "email": f"{_RUN_TAG}_alice@example.test",
        "display_name": "Smoke Alice (vegan)",
        "dietary_restrictions": ["vegan", "gluten_free"],
        "preferred_cuisines": ["thai", "californian"],
        "disliked_cuisines": ["steakhouse"],
        "budget_min": 15,
        "budget_max": 40,
    },
    {
        "username": f"{_RUN_TAG}_bob",
        "email": f"{_RUN_TAG}_bob@example.test",
        "display_name": "Smoke Bob (budget-tight)",
        "dietary_restrictions": [],
        "preferred_cuisines": ["mexican", "vietnamese"],
        "disliked_cuisines": ["fine_dining"],
        "budget_min": 8,
        "budget_max": 20,
    },
    {
        "username": f"{_RUN_TAG}_carol",
        "email": f"{_RUN_TAG}_carol@example.test",
        "display_name": "Smoke Carol (omnivore)",
        "dietary_restrictions": [],
        "preferred_cuisines": ["italian", "thai"],
        "disliked_cuisines": ["steakhouse", "german"],
        "budget_min": 20,
        "budget_max": 60,
    },
]


def _preflight_diagnostics() -> list[str]:
    """Return human-readable warnings for missing credentials (empty == all set).

    This does NOT block the run — it lets us distinguish 'code path works but a
    credential/DB is missing' from 'code is broken' when the pipeline later
    raises on an auth/connection error.
    """
    warnings: list[str] = []
    if not settings.openrouter_api_key:
        warnings.append(
            "OPENROUTER_API_KEY is empty -> embeddings (embed_text) will fail. "
            "Set OPENROUTER_API_KEY in backend/ai_service/.env."
        )
    if not settings.salesforce_api_key:
        warnings.append(
            "SALESFORCE_API_KEY is empty -> LLM re-rank (Salesforce gateway) will fail. "
            "Set SALESFORCE_API_KEY in backend/ai_service/.env."
        )
    if not settings.node_extra_ca_certs:
        warnings.append(
            "NODE_EXTRA_CA_CERTS is empty -> TLS to the Salesforce gateway uses "
            "default certifi verification, which may reject the corporate cert. "
            "Set NODE_EXTRA_CA_CERTS to the corporate CA bundle path if LLM calls "
            "fail with an SSL error."
        )
    return warnings


def _is_missing_creds_error(exc: BaseException) -> bool:
    """Heuristically classify an error as 'credentials/network missing' vs a real bug.

    Auth (401), SSL/cert, and connection/timeout failures mean the code path is
    fine but the environment is not provisioned — those should degrade
    gracefully rather than surface as a broken-code traceback.
    """
    text_blob = f"{type(exc).__name__}: {exc}".lower()
    needles = (
        "authenticationerror",
        "permissiondenied",
        "401",
        "403",
        "api key",
        "api_key",
        "unauthorized",
        "ssl",
        "certificate",
        "certificate_verify",
        "connect",
        "connection",
        "timeout",
        "timed out",
        "getaddrinfo",
        "name or service not known",
        "nodename nor servname",
    )
    return any(needle in text_blob for needle in needles)


async def _ensure_restaurants() -> bool:
    """Ensure embedded restaurants exist; run the seeder once if none. Return ok."""
    async with async_session_factory() as db:
        total = await restaurant_crud.count(db)
        embedded = await restaurant_crud.count_with_embedding(db)

    print(f"[1/4] Restaurants present: total={total}, with_embedding={embedded}.")
    if embedded > 0:
        return True

    print(
        "      No embedded restaurants found -> running scripts.seed_restaurants.main() ..."
    )
    # Imported here (not at module top) so an import-only smoke check never pulls
    # in the seeder's embedding client eagerly.
    from scripts.seed_restaurants import main as seed_main

    await seed_main()

    async with async_session_factory() as db:
        embedded = await restaurant_crud.count_with_embedding(db)
    print(f"      After seeding: with_embedding={embedded}.")
    if embedded == 0:
        print(
            "      WARNING: seeding produced 0 embedded restaurants (embeddings "
            "likely failed — see OPENROUTER_API_KEY). similarity_search will "
            "return no candidates and the pipeline will yield an empty result."
        )
    return embedded > 0


async def _create_throwaway_session() -> tuple[int, list[int], int]:
    """Insert users/profiles/group/session/members/qa in FK order (one transaction).

    Returns (session_id, user_ids, group_id) for later cleanup.
    """
    async with async_session_factory() as db:
        # Users first (Profile/Session FK -> User.id).
        users = [
            User(
                username=m["username"],
                email=m["email"],
                display_name=m["display_name"],
            )
            for m in _MEMBERS
        ]
        db.add_all(users)
        await db.flush()  # assign user ids without ending the transaction
        user_ids = [u.id for u in users]

        # Profiles (one per user, divergent prefs).
        profiles = [
            Profile(
                user_id=uid,
                dietary_restrictions=m["dietary_restrictions"],
                disliked_cuisines=m["disliked_cuisines"],
                preferred_cuisines=m["preferred_cuisines"],
                budget_min=m["budget_min"],
                budget_max=m["budget_max"],
                liked_restaurant_ids=[],
            )
            for uid, m in zip(user_ids, _MEMBERS, strict=True)
        ]
        db.add_all(profiles)

        # Group (Session.group_id FK -> Group.id, optional but exercised here).
        group = Group(name=f"{_RUN_TAG} throwaway group")
        db.add(group)
        await db.flush()

        # Session (host = first user). No group-budget column — budget is a
        # per-member ceiling the orchestrator scores against on demand.
        # scheduled_for drives the open/closed hard filter (Mon 7pm here).
        session = Session(
            host_user_id=user_ids[0],
            group_id=group.id,
            time_limit=15,
            scheduled_for=datetime(2026, 7, 13, 19, 0),
        )
        db.add(session)
        await db.flush()

        # Members (all confirmed so the service's readiness guard passes).
        db.add_all(
            SessionMember(session_id=session.id, user_id=uid, status=True)
            for uid in user_ids
        )

        # Qa: one row per member (session-scoped overrides). The HOST's row
        # carries the event's occasion and the shared PRIMARY search location
        # (downtown SF, wide radius so the box spans to the East Bay). The LAST
        # member adds a PREFERRED location (Oakland) — the secondary anchor for
        # the between-host-and-member ranking — plus a QA cuisine override (ramen)
        # that outranks their profile cuisines while still counting them. (The
        # event time lives on Session.scheduled_for, not Qa.)
        host_uid = user_ids[0]
        member_uid = user_ids[-1]
        db.add_all(
            Qa(
                session_id=session.id,
                user_id=uid,
                occasion="casual group dinner" if uid == host_uid else None,
                location_mode="manual" if uid in (host_uid, member_uid) else None,
                location_lat=(
                    37.7749 if uid == host_uid
                    else 37.8044 if uid == member_uid
                    else None
                ),
                location_lon=(
                    -122.4194 if uid == host_uid
                    else -122.2712 if uid == member_uid
                    else None
                ),
                radius_miles=20.0 if uid == host_uid else None,
                preferred_cuisines=["ramen"] if uid == member_uid else [],
                budget_max=45 if uid == host_uid else None,
            )
            for uid in user_ids
        )

        await db.commit()
        session_id = session.id
        group_id = group.id

    print(
        f"[2/4] Created throwaway session_id={session_id} with 3 confirmed members "
        f"(user_ids={user_ids}, group_id={group_id})."
    )
    return session_id, user_ids, group_id


async def _cleanup(session_id: int | None, user_ids: list[int], group_id: int | None) -> None:
    """Delete throwaway rows in reverse-FK order (best-effort, never raises)."""
    print("[4/4] Cleaning up throwaway data ...")
    async with async_session_factory() as db:
        try:
            if session_id is not None:
                # Recommendations/items reference the session; remove them first.
                await db.execute(
                    text(
                        'DELETE FROM "RecommendationItem" WHERE recommendation_id IN '
                        '(SELECT id FROM "Recommendation" WHERE session_id = :sid)'
                    ),
                    {"sid": session_id},
                )
                await db.execute(
                    text('DELETE FROM "Recommendation" WHERE session_id = :sid'),
                    {"sid": session_id},
                )
                await db.execute(
                    text('DELETE FROM "Qa" WHERE session_id = :sid'),
                    {"sid": session_id},
                )
                await db.execute(
                    text('DELETE FROM "SessionMember" WHERE session_id = :sid'),
                    {"sid": session_id},
                )
                await db.execute(
                    text('DELETE FROM "Session" WHERE id = :sid'),
                    {"sid": session_id},
                )
            if user_ids:
                await db.execute(
                    text('DELETE FROM "Profile" WHERE user_id = ANY(:uids)'),
                    {"uids": user_ids},
                )
                await db.execute(
                    text('DELETE FROM "User" WHERE id = ANY(:uids)'),
                    {"uids": user_ids},
                )
            if group_id is not None:
                await db.execute(
                    text('DELETE FROM "Group" WHERE id = :gid'),
                    {"gid": group_id},
                )
            await db.commit()
            print("      Cleanup complete.")
        except SQLAlchemyError as exc:  # noqa: BLE001 — cleanup must never crash the run.
            await db.rollback()
            print(f"      WARNING: cleanup failed ({exc}); manual cleanup may be needed.")


async def _resolve_and_print(result: dict) -> None:
    """Resolve restaurant names for the ranked ids and pretty-print the ranking."""
    items = result.get("items", [])
    print(
        f"[3/4] Recommendation id={result.get('recommendation_id')} for "
        f"session_id={result.get('session_id')} produced {len(items)} ranked item(s):"
    )
    if not items:
        print(
            "      (empty) — the pipeline ran end-to-end but produced no picks. "
            "Most likely no restaurants matched the hard dietary/geo/hours "
            "filters (budget is soft — it only reweights), or embeddings were "
            "unavailable so retrieval found nothing."
        )
        return

    ids = [it["restaurant_id"] for it in items]
    async with async_session_factory() as db:
        rows = await restaurant_crud.get_by_ids(db, ids)
    name_by_id = {r.id: r.name for r in rows}

    for rank, it in enumerate(items, start=1):
        rid = it["restaurant_id"]
        name = name_by_id.get(rid, f"<restaurant #{rid}>")
        score = it.get("match_score")
        score_str = f"{score:.3f}" if isinstance(score, (int, float)) else "n/a"
        justification = it.get("justification") or "(no justification)"
        print(f"      #{rank}  {name}  [score={score_str}]")
        print(f"           {justification}")


async def _run() -> int:
    """Drive the full smoke flow; return a process exit code (0 = success/graceful)."""
    print("=== Orchestrator end-to-end smoke test ===")
    print(f"DATABASE_URL = {settings.database_url}")
    print(f"LLM model    = {settings.llm_model}")
    print(f"Embed model  = {settings.embedding_model}")

    warnings = _preflight_diagnostics()
    if warnings:
        print("\n-- Preflight credential warnings (non-blocking) --")
        for w in warnings:
            print(f"  * {w}")
        print(
            "  These may cause the pipeline to degrade (fewer/no picks) or fail "
            "with a credential error below.\n"
        )

    # --- DB reachability check up front, so a missing DB is a clean diagnostic. ---
    # Catch broadly: besides SQLAlchemy connection errors, the async engine can
    # raise a plain ValueError if the greenlet runtime dep is missing (a known
    # SQLAlchemy packaging gap on macOS arm64). Both are environment issues, not
    # bugs in this script — so we surface a fix hint rather than a traceback.
    try:
        async with async_session_factory() as db:
            await db.execute(text("SELECT 1"))
    except Exception as exc:  # noqa: BLE001
        hint = (
            "  Fix: ensure PostgreSQL (with pgvector) is running and DATABASE_URL is\n"
            f"  correct ({settings.database_url}).\n"
        )
        if "greenlet" in f"{exc}".lower():
            hint = (
                "  Fix: the 'greenlet' runtime dependency is missing (SQLAlchemy async\n"
                "  needs it). Run `uv sync` in backend/ai_service to install it.\n"
            )
        print(
            "\nDIAGNOSTIC: could not open a database session — the smoke test cannot run.\n"
            f"  Error: {type(exc).__name__}: {exc}\n"
            f"{hint}"
            "  Then re-run:  uv run python -m scripts.smoke_orchestrator\n"
            "  (The code path is intact — this is an environment/DB issue, not a bug.)"
        )
        return 0

    session_id: int | None = None
    user_ids: list[int] = []
    group_id: int | None = None
    try:
        # Step 1: restaurants with embeddings.
        try:
            await _ensure_restaurants()
        except Exception as exc:  # noqa: BLE001
            if _is_missing_creds_error(exc):
                print(
                    "\nDIAGNOSTIC: seeding could not embed restaurants "
                    "(credentials/network).\n"
                    f"  Error: {type(exc).__name__}: {exc}\n"
                    "  Fix: set OPENROUTER_API_KEY in backend/ai_service/.env, then re-run.\n"
                    "  (Code path is intact — this is a credentials issue.)"
                )
                return 0
            raise

        # Step 2: throwaway session.
        session_id, user_ids, group_id = await _create_throwaway_session()

        # Step 3: run the orchestrator via the service entry point.
        try:
            result = await generate_recommendation(session_id)
        except SessionNotReadyError as exc:
            # Should not happen (all members confirmed), but handle explicitly.
            print(f"\nUNEXPECTED: session reported not ready: {exc}")
            return 1
        except Exception as exc:  # noqa: BLE001
            if _is_missing_creds_error(exc):
                print(
                    "\nDIAGNOSTIC: the pipeline reached the LLM/embedding provider but "
                    "the call failed (credentials/network/TLS).\n"
                    f"  Error: {type(exc).__name__}: {exc}\n"
                    "  Fix: set SALESFORCE_API_KEY (Salesforce gateway) and OPENROUTER_API_KEY, and\n"
                    "  NODE_EXTRA_CA_CERTS (corporate CA bundle) if you hit an SSL error,\n"
                    "  in backend/ai_service/.env. Then re-run:\n"
                    "    uv run python -m scripts.smoke_orchestrator\n"
                    "  (The orchestrator wiring is intact — this is a credentials/network issue.)"
                )
                return 0
            raise

        await _resolve_and_print(result)
        print("\nSMOKE TEST PASSED: orchestrator ran end-to-end and persisted a recommendation.")
        return 0
    finally:
        await _cleanup(session_id, user_ids, group_id)


def main() -> None:
    """Entrypoint: run the smoke flow and exit with its status code."""
    raise SystemExit(asyncio.run(_run()))


if __name__ == "__main__":
    main()
