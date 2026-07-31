"""Confirm whether the two services' databases are genuinely divergent.

``scripts/probe_db_hop.py`` found ``gateway/.env`` and ``ai_service/.env`` pointing at
DIFFERENT Render databases (``grubchat`` vs ``grubgroup_db``), with different row counts.
Two readings are possible and they have opposite consequences:

  * BENIGN — one is simply a stale/abandoned copy that nothing currently uses, and the
    running configuration only ever touches one of them.
  * BROKEN — both are live, and ai_service is resolving session/user IDs against a
    database where those IDs mean something different (or nothing). Then an in-session
    analyze turn either FK-violates or, far worse, silently writes a Qa row against the
    WRONG user's id, corrupting a real session's preferences.

The distinguishing evidence is whether the same primary keys refer to the same entities.
This compares the ID sets and, for overlapping IDs, whether the rows describe the same
records. Strictly read-only — SELECTs only, and it prints ids/emails-domains rather than
personal data where it can.

Run:
    cd backend/ai_service
    uv run python -m scripts.probe_split_brain
"""

from __future__ import annotations

import asyncio
import re
from pathlib import Path

import asyncpg


def _read_env_url(env_path: Path) -> str | None:
    """DATABASE_URL from a .env file, skipping commented lines."""
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


async def _snapshot(url: str) -> dict[str, object]:
    """Read the identifying facts needed to compare two databases."""
    conn = await asyncpg.connect(_dsn(url), ssl="require")
    try:
        sessions = await conn.fetch(
            'SELECT id, host_user_id, closed_at FROM "Session" ORDER BY id;'
        )
        users = await conn.fetch('SELECT id, email FROM "User" ORDER BY id;')
        qa = await conn.fetch(
            'SELECT session_id, user_id FROM "Qa" ORDER BY session_id, user_id;'
        )
        latest = await conn.fetchval(
            'SELECT max(created_at) FROM "Session";'
        )
        return {
            "sessions": {
                row["id"]: (
                    row["host_user_id"],
                    "closed" if row["closed_at"] else "open",
                )
                for row in sessions
            },
            "users": {row["id"]: row["email"] for row in users},
            "qa": {(row["session_id"], row["user_id"]) for row in qa},
            "latest_session": latest,
        }
    finally:
        await conn.close()


async def _run() -> int:
    print("=" * 78)
    print("  Split-brain confirmation: do the two DBs describe the same entities?")
    print("=" * 78)
    print()

    root = Path(__file__).resolve().parents[2]
    ai_url = _read_env_url(root / "ai_service" / ".env")
    gw_url = _read_env_url(root / "gateway" / ".env")
    if not ai_url or not gw_url:
        print("  ABORT: need DATABASE_URL in both .env files.")
        return 1

    ai = await _snapshot(ai_url)
    gw = await _snapshot(gw_url)
    ai_name, gw_name = _name(ai_url), _name(gw_url)

    print(f"  ai_service DB : {ai_name}")
    print(f"  gateway DB    : {gw_name}")
    print()

    ai_sessions: dict = ai["sessions"]  # type: ignore[assignment]
    gw_sessions: dict = gw["sessions"]  # type: ignore[assignment]
    ai_users: dict = ai["users"]  # type: ignore[assignment]
    gw_users: dict = gw["users"]  # type: ignore[assignment]

    print("  --- Session ids ---")
    print(f"      {ai_name}: {sorted(ai_sessions)}")
    print(f"      {gw_name}: {sorted(gw_sessions)[:20]}{' ...' if len(gw_sessions) > 20 else ''}")
    print(f"      last created: {ai_name}={ai['latest_session']}  {gw_name}={gw['latest_session']}")
    print()

    # The decisive test: for ids present in BOTH, do they name the same session?
    shared = sorted(set(ai_sessions) & set(gw_sessions))
    print(f"  --- ids present in BOTH databases ({len(shared)}) ---")
    conflicts = 0
    for sid in shared[:12]:
        a_host, a_status = ai_sessions[sid]
        g_host, g_status = gw_sessions[sid]
        same = a_host == g_host
        if not same:
            conflicts += 1
        flag = "SAME" if same else "*** DIFFERENT HOST ***"
        print(
            f"      Session {sid}: host {a_host} ({a_status}) vs "
            f"host {g_host} ({g_status})  {flag}"
        )
    if len(shared) > 12:
        print(f"      ... {len(shared) - 12} more")
    print()

    # Users are the ids the gateway injects into analyze calls, so a mismatch here is
    # the one that silently writes to the wrong person.
    shared_users = sorted(set(ai_users) & set(gw_users))
    user_conflicts = [
        uid for uid in shared_users if ai_users[uid] != gw_users[uid]
    ]
    print(f"  --- User ids in both ({len(shared_users)}); identity mismatches ---")
    if user_conflicts:
        print(f"      *** {len(user_conflicts)} id(s) map to DIFFERENT people ***")
        for uid in user_conflicts[:8]:
            # Show only the domain side of each address.
            a_dom = str(ai_users[uid]).split("@")[-1]
            g_dom = str(gw_users[uid]).split("@")[-1]
            a_pre = str(ai_users[uid])[:3]
            g_pre = str(gw_users[uid])[:3]
            print(f"        id {uid}: {a_pre}***@{a_dom}  vs  {g_pre}***@{g_dom}")
    else:
        print("      none — shared ids refer to the same users.")
    print()

    only_gw = sorted(set(gw_sessions) - set(ai_sessions))
    print("  --- VERDICT ---")
    print(f"      Sessions only in the gateway DB: {len(only_gw)}")
    if only_gw:
        print(f"        e.g. {only_gw[:12]}")
        print("      An analyze turn for any of these hits ai_service, which looks the")
        print(f"      session up in {ai_name}, does NOT find it, and so treats the")
        print("      caller as a NON-host (is_host=False) — then tries to write a Qa row")
        print("      whose session_id/user_id FKs do not exist there.")
    if user_conflicts:
        print("      WORSE: some user ids denote different people across the two DBs,")
        print("      so a write that does land could attach to the wrong account.")
    print()
    print("      Both DBs hold recent data, so neither is obviously abandoned.")
    print("      Per backend/CLAUDE.md the two services MUST share one Postgres")
    print("      (same DB, different driver prefix). This needs an owner decision:")
    print("      which database is canonical? Do not guess — picking wrong loses data.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_run()))
