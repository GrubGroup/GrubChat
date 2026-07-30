"""Stage 0 completion: measure the DB hop, and check the two services share one database.

The Stage 0 latency work established that the LLM provider call (~3.9 s) dominates the
conversational turn. This closes the two gaps in that report:

  1. The DB hop was inferred to be rounding error, not measured. ``analyze_member_turn``
     issues up to three reads before the LLM call ever runs (``get_session``,
     ``get_qa_for_user`` for the host, ``get_qa_for_user`` for the caller). Against a
     REMOTE database those are three serial round-trips, which is a real number, not zero.
  2. ``backend/gateway/.env`` and ``backend/ai_service/.env`` appear to point at DIFFERENT
     remote databases (``grubchat`` vs ``grubgroup_db``). If so, every cross-service AI
     write FK-violates, because ai_service would be writing Qa rows into a database whose
     Session/User rows live elsewhere. That breaks Stage 1-3 before it starts, so it is
     worth confirming rather than assuming.

Strictly read-only: SELECT counts and one timed trivial query per database. No writes,
no DDL.

Run:
    cd backend/ai_service
    uv run python -m scripts.probe_db_hop
"""

from __future__ import annotations

import asyncio
import os
import re
import statistics
import time
from pathlib import Path

import asyncpg

REPS = 5

# The tables the analyze path actually touches, plus the seed catalog.
COUNT_TABLES = ["User", "Session", "SessionMember", "Qa", "Restaurant"]


def _read_env_url(env_path: Path) -> str | None:
    """Pull DATABASE_URL out of a .env file, ignoring commented-out lines."""
    if not env_path.is_file():
        return None
    for line in env_path.read_text().splitlines():
        stripped = line.strip()
        if stripped.startswith("#") or not stripped.startswith("DATABASE_URL="):
            continue
        return stripped.split("=", 1)[1].strip()
    return None


def _to_asyncpg_dsn(url: str) -> str:
    """Normalize a SQLAlchemy/Prisma URL into something asyncpg accepts.

    asyncpg wants a bare postgresql:// DSN and rejects both the ``+asyncpg``
    driver suffix and the ``?ssl=require`` query form SQLAlchemy uses.
    """
    dsn = url.replace("postgresql+asyncpg://", "postgresql://")
    return re.sub(r"[?&]ssl(mode)?=\w+", "", dsn)


def _describe(url: str) -> str:
    """Host + database name only — never echo credentials."""
    match = re.search(r"@([^/]+)/([^?]+)", url)
    return f"{match.group(1)} / {match.group(2)}" if match else "unparseable"


async def _probe(label: str, url: str) -> dict[str, object] | None:
    """Connect, time a trivial query, and count the analyze-path tables."""
    dsn = _to_asyncpg_dsn(url)
    print(f"  --- {label}: {_describe(url)} ---")

    connect_started = time.perf_counter()
    try:
        conn = await asyncio.wait_for(asyncpg.connect(dsn, ssl="require"), timeout=30)
    except Exception as exc:
        print(f"      CONNECT FAILED: {type(exc).__name__}: {str(exc)[:80]}")
        return None
    connect_ms = (time.perf_counter() - connect_started) * 1000.0
    print(f"      connect+TLS      {connect_ms:8.1f} ms")

    try:
        # Trivial round-trip = the per-query floor for this database from here.
        samples: list[float] = []
        for _ in range(REPS):
            started = time.perf_counter()
            await conn.fetchval("SELECT 1;")
            samples.append((time.perf_counter() - started) * 1000.0)
        rtt = statistics.median(samples)
        print(f"      SELECT 1 (p50)   {rtt:8.1f} ms   (n={REPS})")

        counts: dict[str, int | str] = {}
        for table in COUNT_TABLES:
            try:
                counts[table] = await conn.fetchval(f'SELECT count(*) FROM "{table}";')
            except Exception as exc:
                counts[table] = f"ERR {type(exc).__name__}"
        rendered = "  ".join(f"{name}={value}" for name, value in counts.items())
        print(f"      rows: {rendered}")

        # The analyze path's real pre-LLM cost: three serial reads.
        started = time.perf_counter()
        await conn.fetchval('SELECT count(*) FROM "Session";')
        await conn.fetchval('SELECT count(*) FROM "Qa";')
        await conn.fetchval('SELECT count(*) FROM "Qa";')
        serial_ms = (time.perf_counter() - started) * 1000.0
        print(f"      3 serial reads   {serial_ms:8.1f} ms   (the analyze pre-LLM hop)")
        return {"rtt": rtt, "serial": serial_ms, "counts": counts}
    finally:
        await conn.close()


async def _run() -> int:
    print("=" * 78)
    print("  Stage 0 completion — DB hop cost, and do both services share one DB?")
    print("=" * 78)
    print()

    root = Path(__file__).resolve().parents[2]
    ai_url = _read_env_url(root / "ai_service" / ".env")
    gw_url = _read_env_url(root / "gateway" / ".env")

    if not ai_url:
        print("  ABORT: no DATABASE_URL in ai_service/.env")
        return 1

    ai_result = await _probe("ai_service", ai_url)
    print()
    gw_result = None
    if gw_url:
        gw_result = await _probe("gateway", gw_url)
    else:
        print("  --- gateway: no uncommented DATABASE_URL found ---")
    print()

    print("  --- SPLIT-BRAIN CHECK ---")
    if not gw_url:
        print("      gateway DATABASE_URL absent — cannot compare.")
    else:
        ai_target = _describe(ai_url)
        gw_target = _describe(gw_url)
        print(f"      ai_service -> {ai_target}")
        print(f"      gateway    -> {gw_target}")
        if ai_target == gw_target:
            print("      SAME database. OK.")
        else:
            print("      *** DIFFERENT DATABASES ***")
            print("      ai_service writes Qa rows keyed to Session/User rows that live")
            print("      in the OTHER database, so cross-service AI writes will")
            print("      FK-violate (500). The two .env DATABASE_URLs must name the")
            print("      same Postgres. Fix before any Stage 1-3 voice work.")
    print()

    if ai_result:
        print("  --- where the DB sits in the turn budget ---")
        print(
            f"      analyze pre-LLM DB reads ~{ai_result['serial']:.0f} ms  "
            "vs LLM call ~3900 ms"
        )
        share = float(ai_result["serial"]) / 3900.0 * 100.0
        print(f"      DB is ~{share:.1f}% of the measured turn — confirms the LLM leg")
        print("      is the constraint, but this is NOT free on a remote database.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_run()))
