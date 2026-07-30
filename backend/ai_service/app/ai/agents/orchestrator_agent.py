"""Group orchestrator node: reconcile prefs, retrieve, and LLM re-rank."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from app.ai.geo import TIER_BONUS, proximity_tier
from app.ai.graph.state import (
    CandidateRestaurant,
    PipelineState,
    RankedItem,
    ReconciledConstraints,
)
from app.ai.hours import is_open_at
from app.ai.llm.client import chat_completion, strip_json_fence
from app.ai.llm.prompts import build_group_rerank_messages
from app.core.config import settings
from app.ai.rag.embeddings import embed_text
from app.ai.rag.retriever import similarity_search

# How many candidates to pull from pgvector before the geo/hours/LLM re-rank
# passes. Larger than the final top-5 so post-retrieval proximity scoring and the
# open/closed hard filter have room to reorder without starving the shortlist —
# the embedding-only pgvector order is applied BEFORE any geo re-rank, so a
# well-located pick must survive the cut on cosine similarity alone.
_CANDIDATE_LIMIT = 40

# How many of those candidates (top-N by cosine similarity, after the hours hard
# filter) are actually sent to the LLM re-rank. Kept well below _CANDIDATE_LIMIT
# because the re-rank's wall-clock is dominated by how much the model READS (the
# serialized candidate payload) and WRITES (the ranked JSON). The retriever still
# pulls the full _CANDIDATE_LIMIT so proximity/hours filtering has room; only the
# strongest survivors reach the model, which cuts "view results" latency without
# hurting quality (the frontend only shows the top 5).
_RERANK_LIMIT = 20

# Default search radius (miles) applied when the host set a location but no
# explicit radius (the common case — the analyze prompt doesn't ask for one, so
# Qa.radius_miles is usually null). Without this the retriever's bounding box is
# skipped entirely (it requires BOTH center + radius), degrading to unbounded
# global cosine retrieval — the proximity tiers would then rank against places
# anywhere. A generous city-scale default keeps retrieval geographically anchored
# without excluding a member's cross-town preferred spot.
_DEFAULT_RADIUS_MILES = 15.0


# Venue-local timezone for the open/closed check. Session.scheduled_for is stored
# as a UTC instant (the frontend sends dt.toISOString()), but restaurant `hours`
# strings are LOCAL wall-clock ("Mon-Sun 11:00-22:00"). Comparing a naive UTC
# datetime against local hours shifts a 7 PM PT pick to 02:00 the next day, which
# reads as closed for every venue and empties the candidate list. The catalog is
# all SF-area, so we hardcode Pacific for now; make this per-restaurant later.
_VENUE_TZ = ZoneInfo("America/Los_Angeles")


def _to_venue_localtime(when: datetime) -> datetime:
    """Convert a stored event time to naive venue-local wall-clock for is_open_at.

    scheduled_for is persisted as a UTC instant. A naive value is assumed UTC
    (that's how it was stored); an aware value is converted from its own zone.
    Returns a naive datetime in venue-local time so it lines up with the local
    `hours` strings.
    """
    aware = when.replace(tzinfo=timezone.utc) if when.tzinfo is None else when
    return aware.astimezone(_VENUE_TZ).replace(tzinfo=None)


# How much a session-scoped Qa cuisine outweighs a durable Profile cuisine. A
# Profile like/dislike is +/-1; a QA override is +/-QA_CUISINE_WEIGHT. Additive
# (not replacing) so the Profile signal still counts — e.g. profile "japanese"
# (+1) plus QA "mexican" (+2) ranks mexican first while japanese stays in play.
_QA_CUISINE_WEIGHT = 2.0


def _reconcile(state: PipelineState) -> ReconciledConstraints:
    """Merge member prefs + Qa signals into hard/soft group constraints.

    required_dietary is the UNION of every member's dietary_restrictions and is
    treated as HARD downstream. Budget uses each member's EFFECTIVE cap (their
    QA budget override this session, else their Profile budget): price_max is the
    min of those caps (the most-constrained member gates the group), and
    avg_budget is their mean (the group's spend sweet-spot, handed to the re-rank
    so top picks land near it — there is no Session.avg_budget column). Cuisine
    weights reward preferred cuisines and penalize disliked ones, summed across
    members: durable Profile cuisines score +/-1 and session QA cuisines add
    +/-_QA_CUISINE_WEIGHT on top, so a QA override outranks the Profile for this
    session while still counting the Profile taste. occasion / center / radius
    come from the host-authored session signals.
    """
    required_dietary: list[str] = []
    seen_dietary: set[str] = set()
    budget_caps: list[int] = []
    cuisine_weights: dict[str, float] = {}

    for member in state.members:
        for tag in member.dietary_restrictions:
            if tag and tag not in seen_dietary:
                seen_dietary.add(tag)
                required_dietary.append(tag)
        # Skip a 0 effective cap on purpose: budget_max is a required positive
        # Int on Profile, so 0 is the "no budget data" sentinel (MemberPref's
        # default), NOT "this diner can spend $0". Including it would set
        # price_max=0 and filter out every restaurant. Do not "fix" this to
        # `is not None` — that reintroduces the empty-candidates bug.
        if member.effective_budget_max:
            budget_caps.append(member.effective_budget_max)
        # Durable Profile cuisines (+/-1).
        for cuisine in member.preferred_cuisines:
            if cuisine:
                cuisine_weights[cuisine] = cuisine_weights.get(cuisine, 0.0) + 1.0
        for cuisine in member.disliked_cuisines:
            if cuisine:
                cuisine_weights[cuisine] = cuisine_weights.get(cuisine, 0.0) - 1.0
        # Session QA overrides, weighted heavier so they dominate this session.
        for cuisine in member.qa_preferred_cuisines:
            if cuisine:
                cuisine_weights[cuisine] = (
                    cuisine_weights.get(cuisine, 0.0) + _QA_CUISINE_WEIGHT
                )
        for cuisine in member.qa_disliked_cuisines:
            if cuisine:
                cuisine_weights[cuisine] = (
                    cuisine_weights.get(cuisine, 0.0) - _QA_CUISINE_WEIGHT
                )

    price_max: float | None = min(budget_caps) if budget_caps else None
    avg_budget: float | None = (
        sum(budget_caps) / len(budget_caps) if budget_caps else None
    )

    # `center` is the retrieval anchor + PRIMARY location weight: the host's
    # location (resolved into state.qa by _build_session_signals, falling back to
    # a member's when the host set none). It seeds the bounding box.
    center: tuple[float, float] | None = None
    if state.qa.location_lat is not None and state.qa.location_lon is not None:
        center = (state.qa.location_lat, state.qa.location_lon)

    # Secondary anchors: each member's preferred (closer-to-them) location. Skip
    # any that coincide with the center (e.g. the host's own row) so the corridor
    # test compares distinct points. Null coords are already excluded by the
    # MemberPref.location property.
    member_locations: list[tuple[float, float]] = []
    for member in state.members:
        loc = member.location
        if loc is not None and loc != center:
            member_locations.append(loc)

    # Apply a default radius when a center exists but no explicit radius was set,
    # so the retriever's bounding box always engages (it needs BOTH). Without a
    # center, radius is irrelevant (no box) — leave it as-is.
    radius_miles = state.qa.radius_miles
    if center is not None and radius_miles is None:
        radius_miles = _DEFAULT_RADIUS_MILES

    return ReconciledConstraints(
        required_dietary=required_dietary,
        price_max=price_max,
        avg_budget=avg_budget,
        center=center,
        radius_miles=radius_miles,
        host_location=center,
        member_locations=member_locations,
        cuisine_weights=cuisine_weights,
    )


def _build_query_text(
    reconciled: ReconciledConstraints, state: PipelineState
) -> str:
    """Compose a natural-language query string to embed for retrieval."""
    parts: list[str] = ["Group dining recommendation."]
    if state.qa.occasion:
        parts.append(f"Occasion: {state.qa.occasion}.")

    liked = [c for c, w in reconciled.cuisine_weights.items() if w > 0]
    disliked = [c for c, w in reconciled.cuisine_weights.items() if w < 0]
    if liked:
        parts.append(f"Preferred cuisines: {', '.join(sorted(liked))}.")
    if disliked:
        parts.append(f"Avoid cuisines: {', '.join(sorted(disliked))}.")
    if reconciled.required_dietary:
        parts.append(
            f"Must satisfy dietary needs: {', '.join(reconciled.required_dietary)}."
        )
    if reconciled.price_max is not None:
        parts.append(f"Budget per person up to {reconciled.price_max:.0f}.")
    if reconciled.avg_budget is not None:
        parts.append(f"Group typically spends around {reconciled.avg_budget:.0f} per person.")
    return " ".join(parts)


def _parse_ranked(raw: str, valid_ids: set[int]) -> list[RankedItem]:
    """Parse the strict-JSON re-rank response into validated RankedItems.

    Robust to code fences and to the model wrapping the array in an object.
    Each item must reference a known candidate id; match_score is clamped to
    [0, 1] and justification is truncated to 240 chars. Malformed entries and
    unknown/duplicate ids are dropped.
    """
    if not raw:
        return []
    try:
        parsed = json.loads(strip_json_fence(raw))
    except (ValueError, TypeError):
        return []

    if isinstance(parsed, dict):
        # Tolerate {"items": [...]} / {"results": [...]} / {"ranking": [...]}.
        for key in ("items", "results", "ranking", "recommendations"):
            if isinstance(parsed.get(key), list):
                parsed = parsed[key]
                break
    if not isinstance(parsed, list):
        return []

    ranked: list[RankedItem] = []
    used_ids: set[int] = set()
    for entry in parsed:
        if not isinstance(entry, dict):
            continue
        try:
            restaurant_id = int(entry["restaurant_id"])
        except (KeyError, TypeError, ValueError):
            continue
        if restaurant_id not in valid_ids or restaurant_id in used_ids:
            continue
        try:
            score = float(entry.get("match_score", 0.0))
        except (TypeError, ValueError):
            score = 0.0
        score = max(0.0, min(1.0, score))
        justification = str(entry.get("justification", "") or "")[:240]

        used_ids.add(restaurant_id)
        ranked.append(
            RankedItem(
                restaurant_id=restaurant_id,
                match_score=score,
                justification=justification,
            )
        )
    return ranked


def _build_candidates(
    hits: list, reconciled: ReconciledConstraints, state: PipelineState
) -> list[CandidateRestaurant]:
    """Turn retrieval hits into CandidateRestaurants with geo/hours/tier attached.

    Each candidate keeps its coordinates + hours, is classified into a proximity
    tier (between-host-and-member > host > member > far) against the reconciled
    anchors, and gets an `is_open` flag evaluated at the session's chosen time.
    A candidate that parses as CLOSED at that time is HARD-FILTERED OUT (D4) —
    unknown/unparseable/null hours parse as open, so only confidently-closed
    venues are dropped. With no event time set, hours are not filtered at all.
    """
    # Convert the stored UTC event time to venue-local wall-clock ONCE, so the
    # per-restaurant open/closed check compares like-for-like against local hours.
    local_when = (
        _to_venue_localtime(state.scheduled_for)
        if state.scheduled_for is not None
        else None
    )

    candidates: list[CandidateRestaurant] = []
    for restaurant, distance in hits:
        if restaurant.id is None:
            continue

        point = (
            (restaurant.lat, restaurant.long)
            if restaurant.lat is not None and restaurant.long is not None
            else None
        )
        tier = proximity_tier(
            point,
            host=reconciled.host_location,
            members=reconciled.member_locations,
        )

        # Open/closed at the chosen event time (in venue-local wall-clock). None
        # time -> is_open None (unknown, not filtered); known time -> True/False,
        # and a definite False is dropped.
        if local_when is not None:
            is_open = is_open_at(restaurant.hours, local_when)
            if not is_open:
                continue  # hard-filter confidently-closed venues out of the top picks
        else:
            is_open = None

        candidates.append(
            CandidateRestaurant(
                id=restaurant.id,
                name=restaurant.name,
                cuisine_tags=list(restaurant.cuisine_tags or []),
                dietary_tags=list(restaurant.dietary_tags or []),
                price_avg=restaurant.price_avg,
                avg_rating=restaurant.avg_rating,
                distance=distance,
                lat=restaurant.lat,
                long=restaurant.long,
                hours=restaurant.hours,
                is_open=is_open,
                proximity_tier=tier,
            )
        )
    return candidates


def _blend_proximity(base_score: float, tier: str | None) -> float:
    """Add the proximity-tier bonus to a base match score, clamped to [0, 1]."""
    bonus = TIER_BONUS.get(tier or "far", 0.0)
    return round(max(0.0, min(1.0, base_score + bonus)), 4)


async def orchestrate(state: PipelineState) -> PipelineState:
    """Reconcile prefs, retrieve candidates, LLM re-rank, and fill state.ranked.

    Returns the same PipelineState mutated with `reconciled`, `candidates`, and
    `ranked`. `ranked` items match the RecommendationItem shape exactly
    (restaurant_id, match_score, justification). Beyond cuisine/budget/embedding
    fit, candidates are scored by PROXIMITY (between-host-and-member > host >
    member) and hard-filtered by open/closed at the session's chosen time.
    """
    reconciled = _reconcile(state)
    state.reconciled = reconciled

    query_text = _build_query_text(reconciled, state)
    query_embedding = await embed_text(query_text)

    hits = await similarity_search(
        query_embedding,
        limit=_CANDIDATE_LIMIT,
        required_dietary_tags=reconciled.required_dietary or None,
        price_max=reconciled.price_max,
        center=reconciled.center,
        radius_miles=reconciled.radius_miles,
    )

    candidates = _build_candidates(hits, reconciled, state)
    state.candidates = candidates

    if not candidates:
        state.ranked = []
        return state

    # Only the strongest-by-similarity survivors go to the LLM. Candidates keep the
    # retriever's cosine order (best first), so this is the top-_RERANK_LIMIT slice.
    # Shrinking the payload the model reads and the array it must write back is the
    # main "view results" latency win — the frontend only shows the top 5 anyway.
    rerank_candidates = candidates[:_RERANK_LIMIT]

    messages = build_group_rerank_messages(
        reconciled=reconciled.model_dump(),
        candidates=[c.model_dump() for c in rerank_candidates],
    )
    # NOTE: do NOT pass response_format={"type": "json_object"} here. The active
    # Salesforce/Claude gateway does not honor OpenAI JSON mode and returns an
    # empty "{}" when it's set. The prompt already demands strict JSON and
    # `_parse_ranked` strips code fences, so plain completion is the robust path.
    # max_tokens caps the ranked JSON array (~8 short items) so a chatty model
    # can't stall the pipeline with a long completion.
    #
    # DISABLE REASONING on OpenRouter. The default chat model is a REASONING model
    # (claude-sonnet-5): on this large re-rank prompt it spends the entire
    # max_tokens budget on hidden reasoning tokens and returns content=None
    # (finish_reason="length"), so _parse_ranked gets nothing and every pick falls
    # back to the "LLM re-rank unavailable" embedding+proximity ranking. Turning
    # reasoning off makes it emit the ranked JSON directly. Only OpenRouter
    # understands this knob; the Salesforce/Claude gateway is not a runaway-
    # reasoning model, so scope it to the OpenRouter provider.
    extra_body = (
        {"reasoning": {"enabled": False}}
        if settings.llm_provider.strip().lower() == "openrouter"
        else None
    )
    raw = await chat_completion(
        messages, temperature=0.2, max_tokens=900, extra_body=extra_body
    )

    # valid_ids / tier_by_id come from the SAME sliced list the model saw, so an id
    # it couldn't have been given is rejected and every returned id has a tier.
    valid_ids = {c.id for c in rerank_candidates}
    ranked = _parse_ranked(raw or "", valid_ids)

    # Blend the proximity bonus into the LLM's scores and RE-SORT, so the
    # between-host-and-member geometry the prompt was told about is also enforced
    # deterministically (the LLM sees the tiers but we don't rely on it alone).
    tier_by_id = {c.id: c.proximity_tier for c in rerank_candidates}
    if ranked:
        for item in ranked:
            item.match_score = _blend_proximity(
                item.match_score, tier_by_id.get(item.restaurant_id)
            )
        ranked.sort(key=lambda item: item.match_score, reverse=True)
    else:
        # Fallback: no usable LLM output -> rank by embedding distance, then apply
        # the same proximity blend so the geometry still shapes the order.
        ordered = sorted(
            candidates, key=lambda c: (c.distance if c.distance is not None else 1.0)
        )
        ranked = [
            RankedItem(
                restaurant_id=c.id,
                match_score=_blend_proximity(
                    max(0.0, 1.0 - (c.distance or 0.0)), c.proximity_tier
                ),
                justification="Ranked by embedding similarity + proximity (LLM re-rank unavailable).",
            )
            for c in ordered
        ]
        ranked.sort(key=lambda item: item.match_score, reverse=True)

    state.ranked = ranked
    return state
