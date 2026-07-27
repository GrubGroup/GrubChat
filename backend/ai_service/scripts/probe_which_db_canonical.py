"""Characterize the two divergent databases so an owner can pick the canonical one.

``scripts/probe_split_brain.py`` found the gateway DB (``grubchat``) and the ai_service DB
(``grubgroup_db``) hold **completely disjoint** Session and User id sets, with both written
to on the same day. Disjoint ids rule out "same data, slight drift" and mean these are two
independent datasets — so the fix is not a merge, it is a choice, and choosing wrong
discards real user data.

This gathers the facts that decide it, without writing anything:
  * id ranges and sequence positions (which DB the autoincrement has advanced further in),
  * activity recency per table (which one the running app is actually exercising),
  * whether Better Auth tables are populated (the gateway is the only writer of those, so
    a populated AuthSession implies real browser logins landed there),
  * whether Restaurant embeddings exist (the seeded pgvector catalog the AI path needs).

Read-only: SELECTs and one information_schema lookup.

Run:
    cd backend/ai_service
    uv run python -m scripts.probe_which_db_canonical
"""

from __future__ import annotations

import asyncio
import re
from pathlib import Path

import asyncpg


def _read_env_url(env_path: Path) -> str | None:
    if not env_path.is_file():
        return None
    for line in env_path.read_text().splitlines():
        stripped = line.strip()
        if stripped.startswith("#") or not stripped.startswith("DATABASE_URL="):
            continue
        return stripped.split("=", 1)[1].strip()
    return None


def _dsn(url: str) -> str:
    return re.sub(
        r"[?&]ssl(mode)?=\w+", "", url.replace("postgresql+asyncpg://", "postgresql://")
    )


def _name(url: str) -> str:
    match = re.search(r"@([^/]+)/([^?]+)", url)
    return match.group(2) if match else "?"


async def _scalar(conn: asyncpg.Connection, sql: str) -> object:
    """Run a scalar query, returning an error marker instead of raising."""
    try:
        return await conn.fetchval(sql)
    except Exception as exc:
        return f"ERR {type(exc).__name__}"


async def _characterize(url: str) -> None:
    label = _name(url)
    print(f"  ================ {label} ================")
    conn = await asyncpg.connect(_dsn(url), ssl="require")
    try:
        # Id ranges — where each autoincrement sequence has reached.
        for table in ("User", "Session", "Qa", "SessionMember"):
            lo = await _scalar(conn, f'SELECT min(id) FROM "{table}";')
            hi = await _scalar(conn, f'SELECT max(id) FROM "{table}";')
            n = await _scalar(conn, f'SELECT count(*) FROM "{table}";')
            print(f"      {table:<14} n={n:<5} id range {lo}..{hi}")

        # Recency per table — which dataset the live app is touching.
        print("      --- most recent activity ---")
        for table, column in (
            ("User", "created_at"),
            ("Session", "created_at"),
            ("GroupMessage", "created_at"),
            ("Event", "created_at"),
        ):
            latest = await _scalar(conn, f'SELECT max({column}) FROM "{table}";')
            print(f"      {table:<14} latest {column} = {latest}")

        # Better Auth tables: gateway-only writers. Populated => real logins landed here.
        print("      --- Better Auth (gateway-only writer) ---")
        for table in ("AuthSession", "Account", "Verification"):
            n = await _scalar(conn, f'SELECT count(*) FROM "{table}";')
            print(f"      {table:<14} rows = {n}")

        # The AI path needs embeddings; an unseeded catalog can't serve retrieval.
        print("      --- AI readiness ---")
        total = await _scalar(conn, 'SELECT count(*) FROM "Restaurant";')
        embedded = await _scalar(
            conn, 'SELECT count(*) FROM "Restaurant" WHERE embedding IS NOT NULL;'
        )
        print(f"      Restaurant     {total} rows, {embedded} with embeddings")
        recs = await _scalar(conn, 'SELECT count(*) FROM "Recommendation";')
        print(f"      Recommendation rows = {recs}  (ai_service writes these)")
    finally:
        await conn.close()
    print()


async def _run() -> int:
    print("=" * 78)
    print("  Which database is canonical? (facts only — the call is the owner's)")
    print("=" * 78)
    print()

    root = Path(__file__).resolve().parents[2]
    ai_url = _read_env_url(root / "ai_service" / ".env")
    gw_url = _read_env_url(root / "gateway" / ".env")
    if not ai_url or not gw_url:
        print("  ABORT: need DATABASE_URL in both .env files.")
        return 1

    print(f"  ai_service/.env -> {_name(ai_url)}")
    print(f"  gateway/.env    -> {_name(gw_url)}")
    print()
    await _characterize(ai_url)
    await _characterize(gw_url)

    print("  --- how to read this ---")
    print("      The DB with populated AuthSession/Account rows is where real browser")
    print("      logins happened — that is the gateway's live dataset. The DB with")
    print("      Recommendation rows is where ai_service has been writing. If those")
    print("      are different databases, the split has been live for a while and")
    print("      BOTH hold data someone would miss.")
    print("      Whichever is chosen, the OTHER service's .env must be repointed at it")
    print("      (same DB, different driver prefix: postgresql:// vs")
    print("      postgresql+asyncpg://), and the restaurant embeddings must exist there.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_run()))
