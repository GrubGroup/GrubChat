"""Backfill embeddings for already-seeded restaurants whose `embedding` is NULL.

The catalog rows exist in the Prisma-owned DB (the ~100 mock restaurants); only the
`vector(1024)` `embedding` column is missing. This script fetches every row with a
NULL embedding, computes it via OpenRouter (Qwen3-embedding-8b, 1024-dim), and writes
it back. It is idempotent — rows that already have an embedding are skipped, so it can
be re-run safely and will resume where an interrupted run left off (commits per batch).

Run it (from backend/ai_service, uses that dir's .env). Must be run as a module
(-m) so the `app` package resolves — running the file path directly fails with
ModuleNotFoundError: No module named 'app':

    uv run python -m scripts.backfill_embeddings

Env used (already in backend/ai_service/.env): DATABASE_URL, OPENROUTER_API_KEY,
OPENROUTER_BASE_URL, EMBEDDING_MODEL.
"""

from __future__ import annotations

import asyncio

from sqlmodel import select

from app.ai.rag.embeddings import embed_text
from app.db.session import async_session_factory
from app.models.restaurant import Restaurant

# How many restaurants to embed concurrently. Network-bound; kept modest to stay
# under OpenRouter rate limits while still being much faster than serial.
_CONCURRENCY = 8
# Rows committed per batch, so an interrupted run keeps completed embeddings.
_BATCH_SIZE = 20
# Per-embedding retry attempts on transient OpenRouter/network failures.
_MAX_RETRIES = 3


def _embedding_source(r: Restaurant) -> str:
    """Build the natural-language string embedded for a restaurant.

    Mirrors scripts/seed_restaurants.py::_embedding_source so backfilled vectors
    live in the same space as freshly-seeded ones.
    """
    return (
        f"{r.name}. {r.description or ''}. "
        f"Cuisine: {', '.join(r.cuisine_tags or [])}. "
        f"Dietary: {', '.join(r.dietary_tags or []) or 'none'}."
    )


async def _embed_with_retry(text: str) -> list[float]:
    """Embed `text`, retrying with exponential backoff on transient failures."""
    last_exc: Exception | None = None
    for attempt in range(1, _MAX_RETRIES + 1):
        try:
            return await embed_text(text)
        except Exception as exc:  # noqa: BLE001 — surface after retries exhausted.
            last_exc = exc
            if attempt < _MAX_RETRIES:
                await asyncio.sleep(2 ** (attempt - 1))
    assert last_exc is not None
    raise last_exc


async def main() -> None:
    """Fetch NULL-embedding restaurants, embed concurrently, and persist in batches."""
    async with async_session_factory() as session:
        result = await session.execute(
            select(Restaurant)
            .where(Restaurant.embedding.is_(None))
            .order_by(Restaurant.id)
        )
        pending = list(result.scalars().all())

        total = len(pending)
        if total == 0:
            print("Nothing to do: every restaurant already has an embedding.")
            return

        print(
            f"Backfilling embeddings for {total} restaurant(s) "
            f"(concurrency={_CONCURRENCY}, model=qwen/qwen3-embedding-8b)..."
        )

        sem = asyncio.Semaphore(_CONCURRENCY)
        done = 0
        failed = 0

        async def _embed_one(r: Restaurant) -> tuple[Restaurant, list[float] | None]:
            async with sem:
                try:
                    return r, await _embed_with_retry(_embedding_source(r))
                except Exception as exc:  # noqa: BLE001 — count + report, keep going.
                    print(f"  ! id={r.id} {r.name!r}: embedding failed: {exc}")
                    return r, None

        # Process in batches so completed embeddings are committed incrementally.
        for start in range(0, total, _BATCH_SIZE):
            batch = pending[start : start + _BATCH_SIZE]
            results = await asyncio.gather(*(_embed_one(r) for r in batch))

            for restaurant, embedding in results:
                if embedding is None:
                    failed += 1
                    continue
                restaurant.embedding = embedding
                session.add(restaurant)
                done += 1

            await session.commit()
            print(f"  committed {min(start + len(batch), total)}/{total} processed")

    print(f"Done. embedded={done}, failed={failed}, total={total}.")


if __name__ == "__main__":
    asyncio.run(main())
