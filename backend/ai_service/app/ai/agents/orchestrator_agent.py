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
from app.ai.taxonomy import expand_cuisine_terms

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


# --- Soft budget scoring ------------------------------------------------------
# A budget is a CEILING ("I'm willing to spend up to this much"), never a target.
# Everything below follows from that one sentence, and it is what fixes the bug
# where one high-budget diner dragged the whole group upmarket: the group's fit
# is the fit of the member who can LEAST afford the candidate, so a member whose
# ceiling is above the tightest one has provably zero influence on the ranking.
#
# Relative overage at which ONE member's fit halves. Overage is scored as a
# FRACTION of that member's ceiling, not in dollars: $5 over a $15 ceiling (33%)
# has to hurt far more than $5 over a $90 ceiling (5.6%), and a flat-dollar
# tolerance gets that backwards at both ends of a catalog whose real price tiers
# run $12–$90.
_OVER_BUDGET_KNEE = 0.25

# The most a candidate can lose off its match score for being unaffordable.
# Calibrated against TIER_BONUS (max +0.20 for the "between" corridor) so the
# crossover is statable: at _OVER_BUDGET_KNEE over the tightest ceiling the fit
# is exactly 0.5, so the penalty is exactly 0.20 and cancels the best possible
# location bonus. Anything MORE than 25% over the tightest budget therefore
# loses to an affordable candidate no matter how well located it is.
_BUDGET_WEIGHT = 0.40

# Multiplier on the tightest ceiling for the retrieval prefilter (see
# _reconcile). Recall only — the ranking penalty is what enforces budget.
_RETRIEVAL_HEADROOM = 1.5


def _member_budget_fit(price: float | None, cap: int) -> float:
    """How well `price` fits ONE member's ceiling, in [0, 1].

    Flat 1.0 at or under the cap — a cheaper restaurant can never cost a diner
    anything, so being cheap is NEVER penalized. This is the whole difference
    between "willing to spend up to $X" and "wants to eat at $X places", and it
    is why ``budget_min`` is not read anywhere in this module.

    Past the cap the fit decays as 1/(1+x): strictly monotone and never clipping
    to 0, so a $45 bistro and a $200 tasting menu stay ORDERED — exactly the
    range where a frugal group needs the ranking to discriminate.
    """
    if price is None or price <= cap:
        return 1.0
    return 1.0 / (1.0 + ((price - cap) / cap) / _OVER_BUDGET_KNEE)


def _group_budget_fit(price: float | None, caps: list[int]) -> float | None:
    """The WORST member's fit for this candidate; None when budget doesn't apply.

    Deliberately a min and not a mean. A mean lets high-ceiling members — whose
    fit is 1.0 at every price the tightest member can reach — dilute the penalty
    on a restaurant that prices someone out, which is precisely the reported bug
    in softer clothing: adding wealthy diners to a session would make the group's
    picks more expensive for everyone else. Under a min, a member whose ceiling
    is above the tightest ceiling contributes NOTHING to the ranking, at any
    price. That is the guarantee, not a tuning choice.

    None (score untouched) when the candidate has no price or no member set a
    ceiling — an all-flexible group is ranked on cuisine/rating/location alone.
    """
    if price is None or not caps:
        return None
    return round(min(_member_budget_fit(price, cap) for cap in caps), 4)


def _reconcile(state: PipelineState) -> ReconciledConstraints:
    """Merge member prefs + Qa signals into hard/soft group constraints.

    required_dietary is the UNION of every member's dietary_restrictions and is
    treated as HARD downstream. Budget is SOFT: each member's EFFECTIVE ceiling
    (their QA budget override this session, else their Profile budget) is
    collected into member_budget_caps, and a candidate is scored against them by
    _group_budget_fit. A member who said "I'm flexible" — or has no budget data —
    contributes no ceiling and drops out entirely, which is what makes a flexible
    answer discard their saved Profile budget for the session. Cuisine
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
        # None means this member imposes NO ceiling — they said "I'm flexible"
        # this session (Qa.budget_max == NO_CAP, which also discards their saved
        # Profile budget) or they have no budget data at all. Either way they are
        # left out of the caps entirely rather than contributing a 0, which would
        # read as "can spend $0" and price out every restaurant. See
        # MemberPref.effective_budget_cap.
        cap = member.effective_budget_cap
        if cap is not None:
            budget_caps.append(cap)
        # Cuisine signals are stored COMPACT (group/style keys like "asian"), so
        # this read choke point is where they EXPAND into their concrete member
        # tags (chinese, japanese, thai, ...). expand_cuisine_terms is idempotent,
        # so a legacy row that was stored already-expanded yields identical
        # weights — expanding here rather than at write is purely a latency win
        # (the analyze turn no longer echoes 21 tags per group every turn), with
        # no change to the ranking these weights drive. Durable Profile cuisines
        # score +/-1; session QA cuisines add +/-_QA_CUISINE_WEIGHT on top.
        for cuisine in expand_cuisine_terms(member.preferred_cuisines):
            cuisine_weights[cuisine] = cuisine_weights.get(cuisine, 0.0) + 1.0
        for cuisine in expand_cuisine_terms(member.disliked_cuisines):
            cuisine_weights[cuisine] = cuisine_weights.get(cuisine, 0.0) - 1.0
        # Session QA overrides, weighted heavier so they dominate this session.
        for cuisine in expand_cuisine_terms(member.qa_preferred_cuisines):
            cuisine_weights[cuisine] = (
                cuisine_weights.get(cuisine, 0.0) + _QA_CUISINE_WEIGHT
            )
        for cuisine in expand_cuisine_terms(member.qa_disliked_cuisines):
            cuisine_weights[cuisine] = (
                cuisine_weights.get(cuisine, 0.0) - _QA_CUISINE_WEIGHT
            )

    budget_caps.sort()

    # RECALL GUARDRAIL, NOT A CONSTRAINT — the budget POLICY is the soft
    # _group_budget_fit penalty applied at ranking time. This exists only because
    # price is NOT part of a restaurant's embedding (see
    # scripts/seed_restaurants.py::_embedding_source — name, description, cuisine
    # and dietary tags only), so the retriever's cosine ordering is price-blind:
    # without a WHERE clause, the _CANDIDATE_LIMIT window can fill up entirely
    # with places nobody in the group can afford and the affordable ones never
    # get scored at all.
    #
    # Keyed on the TIGHTEST cap so a high-budget member can neither widen nor
    # narrow retrieval — they are inert here exactly as they are in the ranking.
    # The _RETRIEVAL_HEADROOM multiplier is what makes budget genuinely soft
    # rather than a hard gate: the old exact `price_avg <= min(caps)` filter meant
    # a $15 diner could never even be SHOWN a $16 restaurant, and on a group with
    # one frugal member it cut the catalog so far that "we couldn't find
    # restaurants that fit everyone's budget" was a routine outcome. Everything
    # the headroom admits is then priced by the penalty, so a slightly-over
    # candidate only wins when it is clearly better on cuisine/rating/location.
    retrieval_price_ceiling: float | None = (
        budget_caps[0] * _RETRIEVAL_HEADROOM if budget_caps else None
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
        member_budget_caps=budget_caps,
        retrieval_price_ceiling=retrieval_price_ceiling,
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
    # Budget is deliberately ABSENT from the embedded query. A restaurant's
    # vector is built from its name, description, cuisine tags and dietary tags
    # only (scripts/seed_restaurants.py::_embedding_source) — there is no price
    # in the corpus for a dollar figure to match against, so a budget sentence is
    # unanchored tokens diluting the cuisine/dietary signal that IS there. Worse,
    # the sentence this replaced named the group's AVERAGE spend, which nudged
    # retrieval toward whatever reads as upmarket. Budget now lives entirely in
    # the deterministic score, where Restaurant.price_avg actually exists.
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
    anchors, gets a soft `budget_fit` against the group's ceilings (see
    _group_budget_fit — NEVER a filter), and gets an `is_open` flag evaluated at
    the session's chosen time.
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
                budget_fit=_group_budget_fit(
                    restaurant.price_avg, reconciled.member_budget_caps
                ),
                distance=distance,
                lat=restaurant.lat,
                long=restaurant.long,
                hours=restaurant.hours,
                is_open=is_open,
                proximity_tier=tier,
            )
        )
    return candidates


def _adjusted_score(
    base_score: float, tier: str | None, budget_fit: float | None
) -> float:
    """base + proximity bonus - budget penalty, UNCLAMPED. The true ordering.

    The budget term is SUBTRACTIVE AND NEVER ADDITIVE — there is no bonus for
    being expensive. That is the structural reason a high-budget member cannot
    pull the group upmarket, independent of how the constants are tuned: the best
    a candidate can do on budget is "costs nobody anything" (fit 1.0, penalty 0).

    A `budget_fit` of None (no price, or nobody set a ceiling) is a no-op.

    Unclamped ON PURPOSE, and this is what callers must SORT on. A strong LLM
    score plus the "between" bonus can exceed 1.0, and clamping before the
    comparison would collapse an affordable candidate and an unaffordable one to
    an identical 1.0 — silently discarding the budget penalty in exactly the
    high-scoring region where the top picks are decided. Clamp only when storing
    the score (_blend_score), never when ordering.
    """
    bonus = TIER_BONUS.get(tier or "far", 0.0)
    penalty = _BUDGET_WEIGHT * (1.0 - budget_fit) if budget_fit is not None else 0.0
    return base_score + bonus - penalty


def _blend_score(
    base_score: float, tier: str | None, budget_fit: float | None
) -> float:
    """The STORED/displayed match score: _adjusted_score clamped to [0, 1]."""
    return round(max(0.0, min(1.0, _adjusted_score(base_score, tier, budget_fit))), 4)


async def orchestrate(state: PipelineState) -> PipelineState:
    """Reconcile prefs, retrieve candidates, LLM re-rank, and fill state.ranked.

    Returns the same PipelineState mutated with `reconciled`, `candidates`, and
    `ranked`. `ranked` items match the RecommendationItem shape exactly
    (restaurant_id, match_score, justification). Beyond cuisine/embedding fit,
    candidates are scored by PROXIMITY (between-host-and-member > host > member),
    penalized by BUDGET (soft — how far past the group's tightest ceiling the
    price runs), and hard-filtered by open/closed at the session's chosen time.
    """
    reconciled = _reconcile(state)
    state.reconciled = reconciled

    query_text = _build_query_text(reconciled, state)
    query_embedding = await embed_text(query_text)

    hits = await similarity_search(
        query_embedding,
        limit=_CANDIDATE_LIMIT,
        required_dietary_tags=reconciled.required_dietary or None,
        # The retriever's `price_max` parameter is a plain SQL bound; what we
        # hand it is the recall guardrail, not anyone's stated budget. See
        # ReconciledConstraints.retrieval_price_ceiling.
        price_max=reconciled.retrieval_price_ceiling,
        center=reconciled.center,
        radius_miles=reconciled.radius_miles,
    )

    candidates = _build_candidates(hits, reconciled, state)
    state.candidates = candidates

    if not candidates:
        state.ranked = []
        return state

    # Only the strongest survivors go to the LLM. Shrinking the payload the model
    # reads and the array it must write back is the main "view results" latency
    # win — the frontend only shows the top 5 anyway.
    #
    # When the group set ceilings, the slice is re-ordered by the BUDGET term
    # before it is cut, instead of taking raw cosine order. Retrieval is
    # budget-SOFT now (the ceiling carries _RETRIEVAL_HEADROOM slack) and cosine
    # order is price-blind, so a plain `candidates[:_RERANK_LIMIT]` could hand the
    # model twenty candidates that all run past the group's tightest budget while
    # the affordable ones sat at cosine rank 21 and were never ranked at all.
    # Cosine stays the dominant term (it is the base score); budget only
    # reshuffles around the cut. Same `1.0 - distance` proxy the no-LLM fallback
    # below uses.
    #
    # Deliberately NOT keyed on the full _adjusted_score: the proximity tier must
    # keep applying only to the final LLM-scored blend, as it always has. Folding
    # it in here would let location decide slice MEMBERSHIP — an irreversible
    # admit/reject the model never gets to weigh in on — and would change results
    # for groups with no budget ceilings at all, which this change must not touch.
    if reconciled.member_budget_caps:
        rerank_candidates = sorted(
            candidates,
            key=lambda c: max(0.0, 1.0 - (c.distance if c.distance is not None else 1.0))
            - (
                _BUDGET_WEIGHT * (1.0 - c.budget_fit)
                if c.budget_fit is not None
                else 0.0
            ),
            reverse=True,
        )[:_RERANK_LIMIT]
    else:
        rerank_candidates = candidates[:_RERANK_LIMIT]

    messages = build_group_rerank_messages(
        # retrieval_price_ceiling is withheld from the model on purpose: it is a
        # recall guardrail, and showing it invites the model to read it as a
        # budget the group agreed to (the failure this whole change removes).
        reconciled=reconciled.model_dump(exclude={"retrieval_price_ceiling"}),
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

    # valid_ids / tier_by_id / fit_by_id come from the SAME sliced list the model
    # saw, so an id it couldn't have been given is rejected and every returned id
    # has a tier and a budget fit.
    valid_ids = {c.id for c in rerank_candidates}
    ranked = _parse_ranked(raw or "", valid_ids)

    # Blend the proximity bonus and the budget penalty into the LLM's scores and
    # RE-SORT, so the geometry and the group's ceilings the prompt was told about
    # are also enforced deterministically (the model sees both but we don't rely
    # on it alone — an LLM that ignores the budget guidance cannot promote an
    # unaffordable pick past this).
    tier_by_id = {c.id: c.proximity_tier for c in rerank_candidates}
    fit_by_id = {c.id: c.budget_fit for c in rerank_candidates}
    if ranked:
        # SORT on the unclamped adjustment, STORE the clamped one. A confident
        # LLM score plus the "between" bonus can exceed 1.0, and two candidates
        # that both saturate at a stored 1.0 would otherwise tie — with the stable
        # sort silently handing the win back to the model's own order and
        # discarding the budget penalty exactly where the top picks are decided.
        order = {
            item.restaurant_id: _adjusted_score(
                item.match_score,
                tier_by_id.get(item.restaurant_id),
                fit_by_id.get(item.restaurant_id),
            )
            for item in ranked
        }
        for item in ranked:
            item.match_score = _blend_score(
                item.match_score,
                tier_by_id.get(item.restaurant_id),
                fit_by_id.get(item.restaurant_id),
            )
        ranked.sort(key=lambda item: order[item.restaurant_id], reverse=True)
    else:
        # Fallback: no usable LLM output -> rank by embedding distance, then apply
        # the same blend so geometry and budget still shape the order.
        ordered = sorted(
            candidates, key=lambda c: (c.distance if c.distance is not None else 1.0)
        )
        ranked = [
            RankedItem(
                restaurant_id=c.id,
                match_score=_blend_score(
                    max(0.0, 1.0 - (c.distance or 0.0)),
                    c.proximity_tier,
                    c.budget_fit,
                ),
                justification="Ranked by embedding similarity + proximity + budget fit (LLM re-rank unavailable).",
            )
            for c in ordered
        ]
        ranked.sort(key=lambda item: item.match_score, reverse=True)

    state.ranked = ranked
    return state
