"""Diagnose a tag-format mismatch between the taxonomy and the live restaurant data.

Found while sizing the Deepgram keyterm list for the voice feature: the canonical
tag style documented in ``app/ai/taxonomy.py`` is lowercase UNDERSCORE
(``gluten_free``, ``middle_eastern``), and that is what the conversational agent
writes into Qa/Profile. But the restaurants in the canonical database use
HYPHENS (``gluten-free``, ``middle-eastern``) — 0 underscore tags exist in either
``cuisine_tags`` or ``dietary_tags``.

That matters well beyond voice, because ``ai/rag/retriever.similarity_search``
pushes ``dietary_tags @> required_dietary_tags`` into SQL as a HARD filter. If the
required tag is ``gluten_free`` and every row says ``gluten-free``, the superset
test can never be satisfied and retrieval returns ZERO candidates — a silent
"no restaurants match" rather than an error.

This quantifies the impact:
  1. how many restaurants each dietary tag matches in each format;
  2. whether the hard filter actually empties the candidate set (the real query);
  3. how much of the cuisine vocabulary (a soft preference weight, so a miss is a
     lost signal rather than a broken search) fails to line up.

Read-only.

Run:
    cd backend/ai_service
    uv run python -m scripts.probe_tag_format_mismatch
"""

from __future__ import annotations

import asyncio

from sqlalchemy import TEXT, cast, func, select
from sqlalchemy.dialects.postgresql import ARRAY

from app.ai import taxonomy as tax
from app.db.session import async_session_factory
from app.models.restaurant import Restaurant

# The controlled dietary vocabulary the agent can emit (schemas/ai.py prompt list).
DIETARY_TAGS = ["vegan", "vegetarian", "halal", "kosher", "gluten_free", "nut_free"]


def _emittable_cuisine_tags() -> set[str]:
    """Every cuisine/style tag expansion can actually write (not recognition-only)."""
    out: set[str] = set()
    for key, group in tax.CUISINE_GROUPS.items():
        out.add(key)
        out.update(group["seed_umbrella"])
        out.update(group["members"])
    for key, style in tax.RESTAURANT_STYLES.items():
        out.add(key)
        out.update(style["seed_aliases"])
    return out


async def _run() -> int:
    print("=" * 78)
    print("  Tag-format mismatch: taxonomy (underscore) vs live data (hyphen)")
    print("=" * 78)
    print()

    async with async_session_factory() as db:
        total = (await db.execute(select(func.count()).select_from(Restaurant))).scalar()
        print(f"  restaurants in DB: {total}")
        print()

        print("  --- DIETARY tags (HARD filter — a miss empties the result set) ---")
        print(f"  {'tag':<16}{'underscore':>12}{'hyphen':>10}   verdict")
        broken: list[str] = []
        for tag in DIETARY_TAGS:
            hyphen_form = tag.replace("_", "-")
            counts = {}
            for form in {tag, hyphen_form}:
                n = (
                    await db.execute(
                        select(func.count())
                        .select_from(Restaurant)
                        .where(
                            Restaurant.dietary_tags.op("@>")(
                                cast([form], ARRAY(TEXT))
                            )
                        )
                    )
                ).scalar()
                counts[form] = n
            us = counts.get(tag, 0)
            hy = counts.get(hyphen_form, us if hyphen_form == tag else 0)
            verdict = "ok (single word)" if hyphen_form == tag else (
                "BROKEN — 0 with underscore" if us == 0 and hy > 0 else "matches"
            )
            if hyphen_form != tag and us == 0 and hy > 0:
                broken.append(tag)
            print(f"  {tag:<16}{us:>12}{hy:>10}   {verdict}")
        print()

        # The real query: does the hard filter actually empty retrieval?
        print("  --- the actual hard filter, as the pipeline runs it ---")
        for required in (["gluten_free"], ["gluten-free"], ["vegan", "gluten_free"], ["vegan", "gluten-free"]):
            n = (
                await db.execute(
                    select(func.count())
                    .select_from(Restaurant)
                    .where(Restaurant.embedding.is_not(None))
                    .where(
                        Restaurant.dietary_tags.op("@>")(cast(required, ARRAY(TEXT)))
                    )
                )
            ).scalar()
            flag = "  <-- ZERO CANDIDATES" if n == 0 else ""
            print(f"      required={str(required):<32} candidates={n}{flag}")
        print()

        print("  --- CUISINE tags (SOFT weight — a miss loses signal, not results) ---")
        rows = (
            await db.execute(
                select(func.unnest(Restaurant.cuisine_tags).label("tag")).subquery() is None  # placeholder
                if False
                else select(Restaurant.cuisine_tags)
            )
        ).scalars().all()
        db_tags: set[str] = set()
        for arr in rows:
            db_tags.update(arr or [])
        emittable = _emittable_cuisine_tags()
        overlap = db_tags & emittable
        # How many DB tags would line up if we simply swapped separators?
        recovered = {t for t in emittable if t.replace("_", "-") in db_tags} - overlap
        print(f"      distinct cuisine_tags in DB      : {len(db_tags)}")
        print(f"      taxonomy-emittable tags          : {len(emittable)}")
        print(f"      exact overlap                    : {len(overlap)}")
        print(f"      would match if hyphenated        : {len(recovered)} -> {sorted(recovered)[:10]}")
        print(f"      DB tags unknown to the taxonomy  : {len(db_tags - emittable - {t.replace('_','-') for t in emittable})}")
        print()

    # The above tested RAW literals against the data, which is the data-format
    # question. The behavioral question is what the pipeline now actually emits:
    # normalize_dietary_terms is the only path by which a spoken phrase becomes a
    # required tag, so that is what has to line up.
    print("  --- what the pipeline EMITS today (the fix under test) ---")
    spoken = [
        "gluten free",
        "no nuts",
        "celiac",
        "lactose intolerant",
        "no shellfish",
        "veggie",
        "vegan",
    ]
    unmatched: list[tuple[str, list[str]]] = []
    async with async_session_factory() as db:
        for phrase in spoken:
            emitted = tax.normalize_dietary_terms([phrase])
            n = (
                await db.execute(
                    select(func.count())
                    .select_from(Restaurant)
                    .where(Restaurant.embedding.is_not(None))
                    .where(
                        Restaurant.dietary_tags.op("@>")(cast(emitted, ARRAY(TEXT)))
                    )
                )
            ).scalar()
            flag = "" if n else "   <-- EMPTY, would break the search"
            if not n:
                unmatched.append((phrase, emitted))
            print(f"      {phrase!r:22} -> {str(emitted):20} {n:>4} candidates{flag}")
    print()

    print("  --- VERDICT ---")
    if broken:
        print(f"      Raw underscore literals still match nothing: {broken}")
        print("      (expected — the live data is hyphenated; that is the whole point)")
    if unmatched:
        print(f"      {len(unmatched)} spoken phrase(s) still emit a non-matching tag:")
        for phrase, emitted in unmatched:
            print(f"        {phrase!r} -> {emitted}")
        print("      Add them to taxonomy.DIETARY_SYNONYMS — dietary is a HARD @>")
        print("      filter, so a member asking for one gets ZERO picks, silently.")
    else:
        print("      Every spoken dietary phrase maps to a tag that matches real rows.")
        print("      normalize_dietary_terms is bridging the separator gap correctly.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_run()))
