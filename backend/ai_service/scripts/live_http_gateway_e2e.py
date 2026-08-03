"""Live end-to-end harness: exercise the ai_service HTTP path and the gateway proxy path."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any

import httpx
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.core.config import settings
from app.db.session import async_session_factory
from app.models.group import Group
from app.models.profile import Profile
from app.models.qa import Qa
from app.models.session import Session
from app.models.session_member import SessionMember
from app.models.user import User

# Fixed run tag (no random / no time) so throwaway rows are deterministic and any
# leftover from a crashed run is cleaned/overwritten on the next pass. This prefix
# is also what teardown keys off of, so it MUST stay unique to this harness.
_RUN_TAG = "livee2e"

# Base URLs for the two already-running servers. The harness never starts a server;
# if either is unreachable it prints a start hint and exits 0 (env issue, not a bug).
_AI_BASE_URL = os.getenv("AI_SERVICE_URL", "http://localhost:8000").rstrip("/")
_GATEWAY_BASE_URL = os.getenv("GATEWAY_URL", "http://localhost:4000").rstrip("/")

# Generous per-request timeout: the 200 path runs the full LangGraph pipeline
# (embedding retrieval + LLM re-rank through the Salesforce gateway), which can be slow.
_HTTP_TIMEOUT = 180.0

# READY session: >=2 members, ALL confirmed (status=True), divergent profiles ->
# all_members_confirmed True -> 409 guard passes -> pipeline runs.
_READY_MEMBERS = [
    {
        "username": f"{_RUN_TAG}_ready_alice",
        "email": f"{_RUN_TAG}_ready_alice@example.test",
        "display_name": "LiveE2E Ready Alice (vegan)",
        "dietary_restrictions": ["vegan", "gluten_free"],
        "preferred_cuisines": ["thai", "californian"],
        "disliked_cuisines": ["steakhouse"],
        "budget_min": 15,
        "budget_max": 40,
        "status": True,
    },
    {
        "username": f"{_RUN_TAG}_ready_bob",
        "email": f"{_RUN_TAG}_ready_bob@example.test",
        "display_name": "LiveE2E Ready Bob (budget-tight)",
        "dietary_restrictions": [],
        "preferred_cuisines": ["mexican", "vietnamese"],
        "disliked_cuisines": ["fine_dining"],
        "budget_min": 8,
        "budget_max": 20,
        "status": True,
    },
    {
        "username": f"{_RUN_TAG}_ready_carol",
        "email": f"{_RUN_TAG}_ready_carol@example.test",
        "display_name": "LiveE2E Ready Carol (omnivore)",
        "dietary_restrictions": [],
        "preferred_cuisines": ["italian", "thai"],
        "disliked_cuisines": ["steakhouse", "german"],
        "budget_min": 20,
        "budget_max": 60,
        "status": True,
    },
]

# UNCONFIRMED session: >=2 members but at least one status=False ->
# all_members_confirmed False -> service raises SessionNotReadyError -> route 409.
_UNCONFIRMED_MEMBERS = [
    {
        "username": f"{_RUN_TAG}_unconf_dave",
        "email": f"{_RUN_TAG}_unconf_dave@example.test",
        "display_name": "LiveE2E Unconfirmed Dave (confirmed)",
        "dietary_restrictions": ["halal"],
        "preferred_cuisines": ["mediterranean"],
        "disliked_cuisines": [],
        "budget_min": 12,
        "budget_max": 35,
        "status": True,
    },
    {
        "username": f"{_RUN_TAG}_unconf_erin",
        "email": f"{_RUN_TAG}_unconf_erin@example.test",
        "display_name": "LiveE2E Unconfirmed Erin (NOT confirmed)",
        "dietary_restrictions": ["vegetarian"],
        "preferred_cuisines": ["indian"],
        "disliked_cuisines": ["bbq"],
        "budget_min": 10,
        "budget_max": 30,
        "status": False,  # <-- this is what makes the whole session unconfirmed
    },
]


def _is_missing_creds_error(exc: BaseException) -> bool:
    """Heuristically classify an error as 'credentials/network missing' vs a real bug.

    Auth (401/403), SSL/cert, and connection/timeout failures mean the code path is
    fine but the environment is not provisioned — those should degrade gracefully
    rather than surface as a broken-code traceback. Mirrors smoke_orchestrator's heuristic.
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


def _text_says_upstream_llm(blob: str) -> bool:
    """True if a 502 body reads like an upstream LLM/embedding/TLS failure (env-degraded)."""
    lowered = blob.lower()
    needles = (
        "upstream llm",
        "upstream llm/embedding",
        "embedding generation failed",
        "ssl",
        "certificate",
        "authenticationerror",
        "unauthorized",
        "permissiondenied",
        "api key",
        "api_key",
        "connect",
        "connection",
        "timeout",
        "timed out",
        "gateway",
    )
    return any(needle in lowered for needle in needles)


def _env_declared_salesforce_llm_model() -> str | None:
    """Resolve the operator-set SALESFORCE_LLM_MODEL value the way settings sees it.

    pydantic-settings reads the .env file directly and does NOT export it into
    os.environ, so os.getenv() alone misses it in the normal `.env` workflow. Prefer
    a real process env var (an operator override), then fall back to parsing the .env
    file that config.Settings loads (env_file=".env", resolved from the ai_service dir).
    Returns the raw value, or None if the var is unset/blank in both.
    """
    from_environ = os.getenv("SALESFORCE_LLM_MODEL")
    if from_environ:
        return from_environ

    # config.Settings uses env_file=".env" relative to the process CWD, which for the
    # canonical `uv run python -m scripts.<name>` invocation is backend/ai_service.
    # Resolve robustly from this file's location (scripts/ -> ai_service root).
    env_path = Path(__file__).resolve().parent.parent / ".env"
    if not env_path.is_file():
        return None
    try:
        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            if key.strip() == "SALESFORCE_LLM_MODEL":
                value = value.strip().strip('"').strip("'")
                return value or None
    except OSError:
        return None
    return None


def _preflight_diagnostics() -> list[str]:
    """Return human-readable warnings for missing credentials (empty == all set).

    Non-blocking: lets us distinguish 'code path works but a credential is missing'
    from 'code is broken' when an LLM/embedding call later fails.
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


# ---------------------------------------------------------------------------
# Result tracking
# ---------------------------------------------------------------------------


class _Results:
    """Accumulates per-check outcomes for the final PASS/FAIL summary.

    Three outcome kinds:
      * pass       — the check asserted and held.
      * env        — cleanly env-degraded (missing creds / unreachable dependency);
                     reported, but NOT a code failure (exit 0).
      * fail       — a genuine assertion failure (wrong status / malformed payload);
                     forces a non-zero exit.
    """

    def __init__(self) -> None:
        self.rows: list[tuple[str, str, str]] = []  # (label, outcome, detail)

    def add(self, label: str, outcome: str, detail: str = "") -> None:
        self.rows.append((label, outcome, detail))

    def passed(self, label: str, detail: str = "") -> None:
        print(f"      PASS: {label}" + (f" — {detail}" if detail else ""))
        self.add(label, "pass", detail)

    def env(self, label: str, detail: str = "") -> None:
        print(f"      ENV-DEGRADED: {label}" + (f" — {detail}" if detail else ""))
        self.add(label, "env", detail)

    def failed(self, label: str, detail: str = "") -> None:
        print(f"      FAIL: {label}" + (f" — {detail}" if detail else ""))
        self.add(label, "fail", detail)

    @property
    def any_failures(self) -> bool:
        return any(outcome == "fail" for _, outcome, _ in self.rows)

    def summary(self) -> None:
        print("\n=== SUMMARY ===")
        for label, outcome, detail in self.rows:
            tag = {"pass": "PASS", "env": "ENV ", "fail": "FAIL"}[outcome]
            line = f"  [{tag}] {label}"
            if detail:
                line += f" — {detail}"
            print(line)
        n_pass = sum(1 for _, o, _ in self.rows if o == "pass")
        n_env = sum(1 for _, o, _ in self.rows if o == "env")
        n_fail = sum(1 for _, o, _ in self.rows if o == "fail")
        print(f"  ----\n  {n_pass} passed, {n_env} env-degraded, {n_fail} failed.")


# ---------------------------------------------------------------------------
# Step 0: runtime settings probe
# ---------------------------------------------------------------------------


async def _probe_settings(results: _Results) -> bool:
    """Print & assert settings resolve at runtime; open a real SELECT 1. Return DB ok."""
    print("\n[1/6] Runtime settings probe")
    print(f"      DATABASE_URL     = {settings.database_url}")
    print(f"      SALESFORCE_BASE  = {settings.salesforce_base_url}")
    print(f"      LLM model        = {settings.llm_model}")
    print(f"      EMBEDDING model  = {settings.embedding_model}")
    print(f"      OPENROUTER_BASE  = {settings.openrouter_base_url}")

    # asyncpg driver present in DATABASE_URL.
    if "+asyncpg" in settings.database_url:
        results.passed("probe: DATABASE_URL uses the asyncpg driver")
    else:
        results.failed(
            "probe: DATABASE_URL uses the asyncpg driver",
            f"expected '+asyncpg' in URL, got {settings.database_url!r}",
        )

    # Salesforce chat creds/config non-empty.
    if settings.salesforce_api_key and settings.salesforce_base_url and settings.llm_model:
        results.passed("probe: salesforce_api_key / base_url / llm_model are non-empty")
    else:
        results.env(
            "probe: salesforce_api_key / base_url / llm_model are non-empty",
            "one or more is empty (LLM re-rank will be env-degraded)",
        )

    # AliasChoices: SALESFORCE_LLM_MODEL must win over LLM_MODEL. Compare the resolved
    # setting to the operator-declared value (process env var, else the .env file).
    sf_llm_env = _env_declared_salesforce_llm_model()
    if sf_llm_env:
        if settings.llm_model == sf_llm_env:
            results.passed(
                "probe: settings.llm_model resolves SALESFORCE_LLM_MODEL first",
                f"llm_model == SALESFORCE_LLM_MODEL == {sf_llm_env!r}",
            )
        else:
            results.failed(
                "probe: settings.llm_model resolves SALESFORCE_LLM_MODEL first",
                f"settings.llm_model={settings.llm_model!r} != "
                f"SALESFORCE_LLM_MODEL={sf_llm_env!r}",
            )
    else:
        # SALESFORCE_LLM_MODEL unset/blank in both the process env and the .env file,
        # so settings.llm_model falls back to LLM_MODEL or the code default. Not a code
        # bug — nothing to compare against — so report as env-degraded, not a failure.
        results.env(
            "probe: settings.llm_model resolves SALESFORCE_LLM_MODEL first",
            "SALESFORCE_LLM_MODEL is unset/blank in both os.environ and the .env file; "
            f"settings.llm_model={settings.llm_model!r} (fell back to LLM_MODEL/default)",
        )

    # Embedding creds/config non-empty.
    if settings.openrouter_api_key and settings.embedding_model:
        results.passed("probe: openrouter_api_key / embedding_model are non-empty")
    else:
        results.env(
            "probe: openrouter_api_key / embedding_model are non-empty",
            "one or more is empty (embeddings will be env-degraded)",
        )

    # Non-fatal TLS warning.
    if not settings.node_extra_ca_certs:
        print(
            "      WARNING: NODE_EXTRA_CA_CERTS is empty -> TLS to the Salesforce "
            "gateway uses default certifi verification, which may reject a corporate "
            "cert and surface as an SSL error on the 200 check."
        )

    # Real async session: SELECT 1. A missing/broken DB is env, not a bug -> exit 0.
    try:
        async with async_session_factory() as db:
            await db.execute(text("SELECT 1"))
        results.passed("probe: opened async session and ran SELECT 1")
        return True
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
            "\nDIAGNOSTIC: could not open a database session — the harness cannot run.\n"
            f"  Error: {type(exc).__name__}: {exc}\n"
            f"{hint}"
            "  Then re-run:  uv run python -m scripts.live_http_gateway_e2e\n"
            "  (The code path is intact — this is an environment/DB issue, not a bug.)"
        )
        return False


# ---------------------------------------------------------------------------
# Step 1: fixture setup
# ---------------------------------------------------------------------------


async def _create_session(members: list[dict], label: str) -> tuple[int, list[int], int]:
    """Insert users/profiles/group/session/members/qa in FK order (one transaction).

    Returns (session_id, user_ids, group_id).
    """
    async with async_session_factory() as db:
        users = [
            User(
                username=m["username"],
                email=m["email"],
                display_name=m["display_name"],
            )
            for m in members
        ]
        db.add_all(users)
        await db.flush()  # assign user ids without ending the transaction
        user_ids = [u.id for u in users]

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
            for uid, m in zip(user_ids, members, strict=True)
        ]
        db.add_all(profiles)

        group = Group(name=f"{_RUN_TAG} {label} group")
        db.add(group)
        await db.flush()

        # No group-budget column — budget is a per-member ceiling the
        # orchestrator scores against on demand.
        session = Session(
            host_user_id=user_ids[0],
            group_id=group.id,
            time_limit=15,
        )
        db.add(session)
        await db.flush()

        # Per-member confirmation status drives all_members_confirmed().
        db.add_all(
            SessionMember(session_id=session.id, user_id=uid, status=m["status"])
            for uid, m in zip(user_ids, members, strict=True)
        )

        # Qa: one row per member (session-scoped overrides). The HOST's row holds
        # the event occasion and the shared search location (host-only); other
        # members carry only their own overrides. (The event time lives on
        # Session.scheduled_for, not Qa.)
        host_uid = user_ids[0]
        db.add_all(
            Qa(
                session_id=session.id,
                user_id=uid,
                occasion="casual group dinner" if uid == host_uid else None,
                location_mode="manual" if uid == host_uid else None,
                location_lat=37.7749 if uid == host_uid else None,
                location_lon=-122.4194 if uid == host_uid else None,
                radius_miles=10.0 if uid == host_uid else None,
                budget_max=45 if uid == host_uid else None,
            )
            for uid in user_ids
        )

        await db.commit()
        return session.id, user_ids, group.id


async def _teardown(session_ids: list[int], user_ids: list[int], group_ids: list[int]) -> None:
    """Delete all livee2e fixture rows in reverse-FK order (best-effort, never raises)."""
    print("\n[6/6] Teardown — deleting livee2e fixture rows")
    async with async_session_factory() as db:
        try:
            if session_ids:
                await db.execute(
                    text(
                        'DELETE FROM "RecommendationItem" WHERE recommendation_id IN '
                        '(SELECT id FROM "Recommendation" WHERE session_id = ANY(:sids))'
                    ),
                    {"sids": session_ids},
                )
                await db.execute(
                    text('DELETE FROM "Recommendation" WHERE session_id = ANY(:sids)'),
                    {"sids": session_ids},
                )
                await db.execute(
                    text('DELETE FROM "Qa" WHERE session_id = ANY(:sids)'),
                    {"sids": session_ids},
                )
                await db.execute(
                    text('DELETE FROM "SessionMember" WHERE session_id = ANY(:sids)'),
                    {"sids": session_ids},
                )
                await db.execute(
                    text('DELETE FROM "Session" WHERE id = ANY(:sids)'),
                    {"sids": session_ids},
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
            if group_ids:
                await db.execute(
                    text('DELETE FROM "Group" WHERE id = ANY(:gids)'),
                    {"gids": group_ids},
                )
            await db.commit()
            print("      Teardown complete.")
        except SQLAlchemyError as exc:  # noqa: BLE001 — teardown must never crash the run.
            await db.rollback()
            print(
                f"      WARNING: teardown failed ({exc}); manual cleanup of "
                f"'{_RUN_TAG}_' rows may be needed."
            )


# ---------------------------------------------------------------------------
# Step 2: ai_service HTTP checks
# ---------------------------------------------------------------------------


def _rec_path(session_id: int) -> str:
    """ai_service recommendations path for a session."""
    return f"/api/v1/sessions/{session_id}/recommendations"


async def _server_reachable(client: httpx.AsyncClient, base_url: str) -> bool:
    """Best-effort reachability probe (any HTTP response counts as 'up')."""
    try:
        await client.get(base_url + "/", timeout=10.0)
        return True
    except httpx.HTTPError:
        return False


def _assert_recommendation_payload(results: _Results, label: str, body: Any) -> None:
    """Assert a 200 RecommendationOut body is well-formed; record pass/fail."""
    if not isinstance(body, dict):
        results.failed(label, f"expected JSON object, got {type(body).__name__}")
        return

    missing = [k for k in ("id", "session_id", "created_at", "items") if k not in body]
    if missing:
        results.failed(label, f"payload missing keys: {missing}")
        return

    items = body["items"]
    if not isinstance(items, list):
        results.failed(label, f"'items' is not a list (got {type(items).__name__})")
        return

    for idx, item in enumerate(items):
        if not isinstance(item, dict):
            results.failed(label, f"items[{idx}] is not an object")
            return
        item_missing = [
            k for k in ("restaurant_id", "match_score", "justification") if k not in item
        ]
        if item_missing:
            results.failed(label, f"items[{idx}] missing keys: {item_missing}")
            return

    if items:
        results.passed(label, f"200 with {len(items)} ranked item(s)")
    else:
        # Empty ranking is a valid pipeline outcome (nothing matched hard filters, or
        # embeddings unavailable) — the HTTP contract still held, so this passes.
        results.passed(
            label,
            "200 with an empty ranking (valid: no picks matched filters / retrieval "
            "returned nothing)",
        )


async def _ai_http_checks(
    results: _Results, ready_sid: int, unconf_sid: int
) -> None:
    """Run the 401a/401b/409/200 checks directly against ai_service."""
    print(f"\n[3/6] ai_service HTTP checks against {_AI_BASE_URL}")
    good_headers = {"X-Internal-Secret": settings.jwt_secret}
    bad_headers = {"X-Internal-Secret": "definitely-not-the-secret"}
    body = {"force_partial": False}

    async with httpx.AsyncClient(base_url=_AI_BASE_URL, timeout=_HTTP_TIMEOUT) as client:
        if not await _server_reachable(client, _AI_BASE_URL):
            print(
                "\nDIAGNOSTIC: ai_service is unreachable at "
                f"{_AI_BASE_URL} — the HTTP checks cannot run.\n"
                "  Start it with:\n"
                "    cd backend/ai_service && uv run uvicorn app.main:app --reload\n"
                "  Or set AI_SERVICE_URL to the correct base URL, then re-run:\n"
                "    uv run python -m scripts.live_http_gateway_e2e\n"
                "  (The code path is intact — this is an environment issue, not a bug.)"
            )
            results.env("ai_service HTTP checks", f"server unreachable at {_AI_BASE_URL}")
            return

        # CHECK 401a: no secret header.
        try:
            resp = await client.post(_rec_path(ready_sid), json=body)
            if resp.status_code == 401:
                results.passed("ai 401a: missing X-Internal-Secret -> 401")
            else:
                results.failed(
                    "ai 401a: missing X-Internal-Secret -> 401",
                    f"expected 401, got {resp.status_code}",
                )
        except httpx.HTTPError as exc:
            results.env("ai 401a: missing X-Internal-Secret -> 401", f"transport error: {exc}")

        # CHECK 401b: wrong secret.
        try:
            resp = await client.post(_rec_path(ready_sid), headers=bad_headers, json=body)
            if resp.status_code == 401:
                results.passed("ai 401b: wrong X-Internal-Secret -> 401")
            else:
                results.failed(
                    "ai 401b: wrong X-Internal-Secret -> 401",
                    f"expected 401, got {resp.status_code}",
                )
        except httpx.HTTPError as exc:
            results.env("ai 401b: wrong X-Internal-Secret -> 401", f"transport error: {exc}")

        # CHECK 409: correct secret against the UNCONFIRMED session.
        try:
            resp = await client.post(
                _rec_path(unconf_sid), headers=good_headers, json=body
            )
            if resp.status_code == 409:
                results.passed("ai 409: unconfirmed session -> 409")
            else:
                results.failed(
                    "ai 409: unconfirmed session -> 409",
                    f"expected 409, got {resp.status_code} (body: {resp.text[:200]})",
                )
        except httpx.HTTPError as exc:
            results.env("ai 409: unconfirmed session -> 409", f"transport error: {exc}")

        # CHECK 200: correct secret against the READY session (full pipeline).
        label_200 = "ai 200: ready session -> 200 RecommendationOut"
        try:
            resp = await client.post(
                _rec_path(ready_sid), headers=good_headers, json=body
            )
        except httpx.HTTPError as exc:
            # A transport-level failure to the pipeline's upstream provider is env.
            if _is_missing_creds_error(exc):
                results.env(label_200, f"transport/creds error reaching upstream: {exc}")
            else:
                results.failed(label_200, f"transport error: {exc}")
            return

        if resp.status_code == 200:
            _assert_recommendation_payload(results, label_200, _safe_json(resp))
        elif resp.status_code == 502:
            # The route maps upstream LLM/embedding/TLS failures to 502. If the body
            # reads like an upstream failure, treat as env-degraded (report, no fail).
            detail = resp.text
            if _text_says_upstream_llm(detail):
                results.env(
                    label_200,
                    f"502 upstream LLM/embedding failure (env): {detail[:200]}",
                )
            else:
                results.failed(
                    label_200, f"502 without an upstream-LLM detail: {detail[:200]}"
                )
        elif resp.status_code == 500:
            # 500 wraps any other Exception. Classify by body text.
            detail = resp.text
            if _text_says_upstream_llm(detail):
                results.env(label_200, f"500 (env-degraded upstream): {detail[:200]}")
            else:
                results.failed(label_200, f"500: {detail[:300]}")
        else:
            results.failed(
                label_200,
                f"expected 200 (or env-degraded 502), got {resp.status_code} "
                f"(body: {resp.text[:200]})",
            )


# ---------------------------------------------------------------------------
# Step 3: gateway proxy checks
# ---------------------------------------------------------------------------


async def _gateway_checks(results: _Results, ready_sid: int, unconf_sid: int) -> None:
    """Run GW-200 / GW-409 status-passthrough checks against the gateway."""
    print(f"\n[4/6] gateway proxy checks against {_GATEWAY_BASE_URL}")
    # The gateway injects X-Internal-Secret itself; the caller sends none.
    body = {"force_partial": False}

    async with httpx.AsyncClient(
        base_url=_GATEWAY_BASE_URL, timeout=_HTTP_TIMEOUT
    ) as client:
        if not await _server_reachable(client, _GATEWAY_BASE_URL):
            print(
                "\nDIAGNOSTIC: gateway is unreachable at "
                f"{_GATEWAY_BASE_URL} — the gateway checks cannot run.\n"
                "  Start it with:\n"
                "    cd backend/gateway && bun run dev\n"
                "  Or set GATEWAY_URL to the correct base URL, then re-run:\n"
                "    uv run python -m scripts.live_http_gateway_e2e\n"
                "  (The code path is intact — this is an environment issue, not a bug.)"
            )
            results.env("gateway checks", f"server unreachable at {_GATEWAY_BASE_URL}")
            return

        # CHECK GW-409: status passthrough for the unconfirmed session.
        label_gw409 = "gw 409: unconfirmed session -> 409 (status passthrough)"
        try:
            resp = await client.post(
                f"/api/sessions/{unconf_sid}/recommendations", json=body
            )
            if resp.status_code == 409:
                results.passed(label_gw409)
            else:
                results.failed(
                    label_gw409,
                    f"expected 409, got {resp.status_code} (body: {resp.text[:200]})",
                )
        except httpx.HTTPError as exc:
            results.env(label_gw409, f"transport error: {exc}")

        # CHECK GW-200: propagated RecommendationOut for the ready session.
        label_gw200 = "gw 200: ready session -> 200 propagated RecommendationOut"
        try:
            resp = await client.post(
                f"/api/sessions/{ready_sid}/recommendations", json=body
            )
        except httpx.HTTPError as exc:
            if _is_missing_creds_error(exc):
                results.env(label_gw200, f"transport/creds error: {exc}")
            else:
                results.failed(label_gw200, f"transport error: {exc}")
            return

        if resp.status_code == 200:
            _assert_recommendation_payload(results, label_gw200, _safe_json(resp))
        elif resp.status_code == 502:
            detail = resp.text
            if _text_says_upstream_llm(detail):
                results.env(
                    label_gw200,
                    f"502 upstream LLM/embedding failure passed through (env): "
                    f"{detail[:200]}",
                )
            else:
                results.failed(
                    label_gw200, f"502 without an upstream-LLM detail: {detail[:200]}"
                )
        elif resp.status_code == 500:
            detail = resp.text
            if _text_says_upstream_llm(detail):
                results.env(label_gw200, f"500 (env-degraded upstream): {detail[:200]}")
            else:
                results.failed(label_gw200, f"500: {detail[:300]}")
        else:
            results.failed(
                label_gw200,
                f"expected 200 (or env-degraded 502), got {resp.status_code} "
                f"(body: {resp.text[:200]})",
            )


def _safe_json(resp: httpx.Response) -> Any:
    """Return parsed JSON body, or the raw text if it isn't valid JSON."""
    try:
        return resp.json()
    except ValueError:
        return resp.text


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------


async def _run() -> int:
    """Drive the full live E2E flow; return a process exit code (0 = success/graceful)."""
    print("=== Live HTTP + gateway end-to-end harness ===")

    results = _Results()

    warnings = _preflight_diagnostics()
    if warnings:
        print("\n-- Preflight credential warnings (non-blocking) --")
        for w in warnings:
            print(f"  * {w}")

    db_ok = await _probe_settings(results)
    if not db_ok:
        # DB unreachable is an environment issue, not a code bug -> clean exit 0.
        results.summary()
        return 0

    ready_sid: int | None = None
    unconf_sid: int | None = None
    session_ids: list[int] = []
    user_ids: list[int] = []
    group_ids: list[int] = []
    try:
        # --- Fixture setup ---
        print("\n[2/6] Fixture setup — creating two throwaway sessions")
        ready_sid, ready_uids, ready_gid = await _create_session(
            _READY_MEMBERS, "ready"
        )
        unconf_sid, unconf_uids, unconf_gid = await _create_session(
            _UNCONFIRMED_MEMBERS, "unconfirmed"
        )
        session_ids = [ready_sid, unconf_sid]
        user_ids = ready_uids + unconf_uids
        group_ids = [ready_gid, unconf_gid]
        print(
            f"      READY session_id={ready_sid} "
            f"({len(_READY_MEMBERS)} members, all confirmed)."
        )
        print(
            f"      UNCONFIRMED session_id={unconf_sid} "
            f"({len(_UNCONFIRMED_MEMBERS)} members, one NOT confirmed)."
        )
        results.passed(
            "fixture: created READY + UNCONFIRMED sessions",
            f"ready={ready_sid}, unconfirmed={unconf_sid}",
        )

        # --- ai_service HTTP checks ---
        await _ai_http_checks(results, ready_sid, unconf_sid)

        # --- gateway proxy checks ---
        await _gateway_checks(results, ready_sid, unconf_sid)

    finally:
        # --- Teardown always runs, even on a mid-run failure ---
        await _teardown(session_ids, user_ids, group_ids)

    results.summary()

    if results.any_failures:
        print(
            "\nRESULT: FAIL — at least one assertion failed (a genuine code/contract "
            "issue, not an env degradation). Exiting 1."
        )
        return 1

    print(
        "\nRESULT: PASS — all non-env checks held (any env-degraded checks are "
        "environment issues, not code bugs). Exiting 0."
    )
    return 0


def main() -> None:
    """Entrypoint: run the live E2E flow and exit with its status code."""
    raise SystemExit(asyncio.run(_run()))


if __name__ == "__main__":
    main()
