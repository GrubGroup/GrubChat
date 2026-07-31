"""Data access for recommendations and their items."""

from collections.abc import Sequence

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.models.recommendation import Recommendation
from app.models.recommendation_item import RecommendationItem


async def create_recommendation(
    db: AsyncSession, session_id: int
) -> Recommendation:
    """Insert a new recommendation row for a session and return it."""
    recommendation = Recommendation(session_id=session_id)
    db.add(recommendation)
    await db.commit()
    # No refresh: asyncpg returns the autoincrement `id` from the INSERT itself and
    # `created_at` is a Python-side default_factory, so both are already populated —
    # verified against the live DB. The refresh was one wasted round trip (~85ms).
    return recommendation


async def add_items(
    db: AsyncSession,
    recommendation_id: int,
    items: Sequence[dict],
) -> list[RecommendationItem]:
    """Bulk-insert recommendation items ({restaurant_id, match_score, justification})."""
    rows = [
        RecommendationItem(
            recommendation_id=recommendation_id,
            restaurant_id=item["restaurant_id"],
            match_score=item.get("match_score"),
            justification=item.get("justification"),
        )
        for item in items
    ]
    if not rows:
        return []
    db.add_all(rows)
    await db.commit()
    # No post-commit refresh: `expire_on_commit=False` (db/session.py) leaves the
    # in-memory rows valid, and no caller reads these back (recommendation_service
    # discards the return value). Refreshing cost one SELECT per row — ~620ms for 8
    # items, ~2.9s on the 40-item LLM-fallback branch — all of it discarded.
    return rows


async def get_with_items(
    db: AsyncSession, recommendation_id: int
) -> tuple[Recommendation | None, list[RecommendationItem]]:
    """Return a recommendation and its items (empty list if none / not found)."""
    recommendation = await db.get(Recommendation, recommendation_id)
    if recommendation is None:
        return None, []
    result = await db.execute(
        select(RecommendationItem)
        .where(RecommendationItem.recommendation_id == recommendation_id)
        .order_by(RecommendationItem.id)
    )
    return recommendation, list(result.scalars().all())
