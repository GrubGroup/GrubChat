"""Keyterm vocabulary for STT biasing — built from the tags retrieval matches on.

Deepgram Flux accepts a `keyterm` list that biases recognition toward domain
words. Cuisine names are exactly where a general STT model fails: "Oaxacan",
"Levantine", "banh mi", and "Aegean" are rare in everyday speech, and a mis-heard
cuisine costs a real preference signal.

SINGLE SOURCE OF TRUTH. The terms come from the same vocabulary the recommender
matches on, ranked so the ones retrieval can actually use come first:

  1. tags present on real ``Restaurant`` rows (``cuisine_tags`` +
     ``dietary_tags``), ordered by how many restaurants carry them; then
  2. tags the taxonomy can emit but no restaurant currently has, as filler.

Biasing toward a tag no restaurant carries is wasted budget, hence the ordering.
Deepgram caps the list at 100 terms, and (1) currently totals 88, so nothing real
is dropped today; if the catalog grows past the cap the DB-present tags win and
``build_keyterms`` logs what it cut rather than silently truncating.

KNOWN LIMITATION AT SCALE — revisit when the catalog grows (a ~1k-restaurant
seed is planned). Frequency ranking is the wrong priority once the vocabulary
exceeds the cap, because it is inverted with respect to STT difficulty: today's
11 tags on 4+ restaurants are common English words ("american", "italian",
"mexican") that recognition already gets right unbiased, while the 51
single-restaurant tags are the hard ones ("oaxacan", "aegean-greek", "banh mi").
Simulating a 208-tag catalog confirmed the cap keeps the easy words and drops
exactly the terms biasing exists to help. A better rule at that point is
difficulty-weighted — prefer tags that are rare in English, multi-word, or
non-ASCII-origin — with frequency only as a tiebreak. Left as-is deliberately
because nothing is dropped at the current catalog size, so the heuristic would be
untestable guesswork today.

Terms are emitted as SPOKEN phrases, not storage tags: separators become spaces
("middle-eastern" -> "middle eastern", "fine_dining" -> "fine dining"), because
the biasing hint has to look like what a person says. The reverse mapping back to
canonical tags is not needed here — the transcript goes to ``/analyze``, whose
taxonomy expansion already handles arbitrary wording.
"""

from __future__ import annotations

import asyncio
import logging

from sqlalchemy import text

from app.ai.taxonomy import CUISINE_GROUPS, RESTAURANT_STYLES
from app.db.session import async_session_factory

logger = logging.getLogger(__name__)

# Deepgram Flux documents "up to 100" keyterms; the real cap is 500 TOKENS (not
# 1200 characters). Harmless at today's 88 terms — nothing is near either bound —
# but the char budget below is the conservative one, kept so the same list also
# stays safe for Cartesia's Ink-2 (100 terms / 1200 chars).
MAX_KEYTERMS = 100
MAX_KEYTERM_CHARS = 1200

# Memoized single-flight build. The keyterm list is stable for the process
# lifetime (it changes only when the catalog does), and rebuilding it on every
# voice connection would re-run the DB frequency query on the hot path. Cache the
# result and gate the first build behind a lazily-created lock so N concurrent
# first-callers don't stampede the query. The lock is created INSIDE the coroutine
# (not at import) so it binds to the running loop — an import-time asyncio.Lock
# raises "bound to a different event loop" from the standalone asyncio.run probes.
_keyterms_cache: list[str] | None = None
_keyterms_lock: asyncio.Lock | None = None


def _spoken(tag: str) -> str:
    """Render a storage tag as the phrase a person would say."""
    return tag.replace("_", " ").replace("-", " ").strip()


def _taxonomy_tags() -> list[str]:
    """Every cuisine/style tag the taxonomy can emit (not recognition-only synonyms).

    Synonyms are deliberately excluded: they exist so the LLM can RECOGNIZE loose
    wording, but they are never stored, so biasing toward them would spend cap on
    terms that cannot appear in the catalog.
    """
    out: list[str] = []
    seen: set[str] = set()

    def add(tag: str) -> None:
        if tag and tag not in seen:
            seen.add(tag)
            out.append(tag)

    for key, group in CUISINE_GROUPS.items():
        add(key)
        for tag in (*group["seed_umbrella"], *group["members"]):
            add(tag)
    for key, style in RESTAURANT_STYLES.items():
        add(key)
        for tag in style["seed_aliases"]:
            add(tag)
    return out


async def _db_tags_by_frequency() -> list[str]:
    """Catalog tags ordered by how many restaurants carry them, most first.

    One query over both array columns. Returns [] (not an error) when the catalog
    is empty or unreachable — biasing is an optimization, so a failure here must
    degrade to "no keyterms" rather than break the voice session.
    """
    sql = text(
        """
        SELECT tag, count(*) AS n
        FROM (
            SELECT unnest(cuisine_tags) AS tag FROM "Restaurant"
            UNION ALL
            SELECT unnest(dietary_tags) AS tag FROM "Restaurant"
        ) s
        WHERE tag IS NOT NULL AND tag <> ''
        GROUP BY tag
        ORDER BY n DESC, tag ASC
        """
    )
    try:
        async with async_session_factory() as db:
            result = await db.execute(sql)
            return [row[0] for row in result.all()]
    except Exception as exc:  # never let a bias lookup break the session
        # Not "unbiased": build_keyterms still falls through to the taxonomy terms,
        # so the session is biased by taxonomy, just not by catalog frequency.
        logger.warning(
            "keyterm DB lookup failed, falling back to taxonomy-only bias: %s", exc
        )
        return []


async def build_keyterms(
    limit: int = MAX_KEYTERMS, *, db_tags: list[str] | None = None
) -> list[str]:
    """Build the ranked, de-duplicated, cap-respecting keyterm list.

    DB-present tags first (by frequency), then taxonomy-only tags as filler. Any
    term dropped by the cap is logged — a silent truncation would read as "we
    biased toward everything" when we did not.

    ``db_tags`` may be pre-supplied (already fetched by frequency) to avoid a
    second query; when None it is fetched here.
    """
    if db_tags is None:
        db_tags = await _db_tags_by_frequency()

    ranked: list[str] = []
    seen: set[str] = set()
    for tag in [*db_tags, *_taxonomy_tags()]:
        phrase = _spoken(tag)
        # De-dupe on the SPOKEN form: "latin-american" (DB) and "latin_american"
        # (taxonomy) are one keyterm, and would otherwise burn two slots.
        key = phrase.lower()
        if not phrase or key in seen:
            continue
        seen.add(key)
        ranked.append(phrase)

    kept = ranked[:limit]

    # Also respect a character budget so the same list is safe for Cartesia.
    if sum(len(t) + 1 for t in kept) > MAX_KEYTERM_CHARS:
        budget, trimmed = 0, []
        for term in kept:
            if budget + len(term) + 1 > MAX_KEYTERM_CHARS:
                break
            budget += len(term) + 1
            trimmed.append(term)
        logger.info(
            "keyterms trimmed to %d terms for the %d-char budget",
            len(trimmed),
            MAX_KEYTERM_CHARS,
        )
        kept = trimmed

    dropped = len(ranked) - len(kept)
    if dropped:
        logger.info(
            "keyterms: sending %d of %d candidates (cap %d); dropped %d least-used: %s",
            len(kept),
            len(ranked),
            limit,
            dropped,
            ranked[len(kept) : len(kept) + 10],
        )
    return kept


async def get_keyterms() -> list[str]:
    """Return the memoized keyterm list, building it once per process.

    The hot-path entry point for the voice WebSocket: rebuilding on every
    connection would re-run the DB frequency query for a list that only changes
    when the catalog does. Concurrent first-callers are serialized behind a
    lazily-created lock so they don't stampede the query.

    A DEGRADED build is deliberately NOT cached: build_keyterms returns the 100
    taxonomy terms (never []) when the DB is unreachable, and caching that would
    permanently deny catalog-frequency biasing for the whole process even after the
    DB recovers. We only memoize once _db_tags_by_frequency succeeded — detected by
    re-checking the DB tags here (cheap: a warmed cache short-circuits before this).
    """
    global _keyterms_cache, _keyterms_lock
    if _keyterms_cache is not None:
        return _keyterms_cache

    if _keyterms_lock is None:
        _keyterms_lock = asyncio.Lock()

    async with _keyterms_lock:
        # Re-check under the lock: a racing caller may have filled it while we waited.
        if _keyterms_cache is not None:
            return _keyterms_cache
        db_tags = await _db_tags_by_frequency()
        built = await build_keyterms(db_tags=db_tags)
        if db_tags:
            # DB reachable -> this is the real, catalog-ranked list: cache it.
            _keyterms_cache = built
        else:
            logger.warning(
                "keyterms built without catalog data; not caching so a later "
                "connection can pick up frequency ranking once the DB recovers"
            )
        return built
