"""Narrated, mock-data walkthrough of the group recommendation pipeline.

This is the *demo* sibling of ``scripts/smoke_orchestrator.py``. Where the smoke
test proves the wiring works and prints terse ``[n/4]`` progress, this script is
built to be *watched in a terminal*: it narrates, step by step, exactly what
happens when a group of friends each talk to their own AI preference sub-agent
and a master orchestrator reconciles everyone into one ranked shortlist.

It prints, in order:

  * WHO the mock users are (the group roster + personas).
  * the group session Q&A (occasion / location / budget / time — the ``Qa`` row).
  * each member's spoken answers to their preference sub-agent's questions,
    and the sub-agent's normalized output (the real ``MemberPref``).
  * the master orchestrator's work: reconcile constraints -> build a query ->
    embed it -> hit the restaurant database (pgvector retrieval) -> LLM re-rank.
  * the final TOP 5 restaurants for the whole group, with justifications.

It is the terminal version of what the frontend will show once the backend is
wired to real user voice input. Two modes:

  * DEFAULT (offline mock): no database, no API keys, fully deterministic. It
    drives the *real* pipeline building blocks (``normalize_member``,
    ``_reconcile``, ``_build_query_text``, ``_parse_ranked``) and the *real*
    seed catalog, swapping only the three network/DB providers (embeddings,
    pgvector search, the LLM call) for local deterministic stand-ins. Anyone on
    the team can run it and always see a full top-5.
  * ``--live``: runs the real providers instead — real OpenRouter embeddings,
    real pgvector search against the seeded database, and the real Salesforce/
    Claude re-rank — over the same mock group. Needs a running DB + API keys
    (like the smoke test). No rows are written; this is a read/compute demo.

Run:
    cd backend/ai_service
    uv run python -m scripts.demo_orchestrator            # offline mock (default)
    uv run python -m scripts.demo_orchestrator --live     # real backend path
    uv run python -m scripts.demo_orchestrator --no-color  # disable ANSI colors
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import math
import os
import sys
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

# Real pipeline building blocks — the demo drives these directly so the narrated
# steps are the *actual* logic, not a reimplementation. Only the four providers
# (the analyze-turn LLM, embed, retrieve, re-rank) are swapped for local mocks in
# offline mode.
import app.ai.agents.conversation_agent as conversation_agent
from app.ai.agents.conversation_agent import analyze_turn
from app.ai.agents.orchestrator_agent import (
    _CANDIDATE_LIMIT,
    _build_query_text,
    _group_budget_fit,
    _parse_ranked,
    _reconcile,
)
from app.ai.agents.preference_agent import normalize_member
from app.ai.graph.state import (
    CandidateRestaurant,
    MemberPref,
    PipelineState,
    QaSignals,
    RankedItem,
    ReconciledConstraints,
)
from app.ai.llm.prompts import build_group_rerank_messages
from app.schemas.ai import ConversationTurn, ExtractedSignals

# ---------------------------------------------------------------------------
# Terminal styling (ANSI). Auto-disabled when piped, NO_COLOR set, or --no-color.
# ---------------------------------------------------------------------------


class Ink:
    """Tiny ANSI color helper; every method is a no-op when color is disabled."""

    def __init__(self, enabled: bool) -> None:
        self.enabled = enabled

    def _wrap(self, text: str, code: str) -> str:
        return f"\033[{code}m{text}\033[0m" if self.enabled else text

    def bold(self, t: str) -> str:
        return self._wrap(t, "1")

    def dim(self, t: str) -> str:
        return self._wrap(t, "2")

    def header(self, t: str) -> str:
        return self._wrap(t, "1;36")  # bold cyan

    def agent(self, t: str) -> str:
        return self._wrap(t, "35")  # magenta — the AI sub-agent / orchestrator

    def user(self, t: str) -> str:
        return self._wrap(t, "32")  # green — a human diner speaking

    def db(self, t: str) -> str:
        return self._wrap(t, "33")  # yellow — database / RAG access

    def sys(self, t: str) -> str:
        return self._wrap(t, "34")  # blue — pipeline/system step markers

    def good(self, t: str) -> str:
        return self._wrap(t, "1;32")  # bold green — final results

    def warn(self, t: str) -> str:
        return self._wrap(t, "1;33")


def _make_ink(no_color: bool) -> Ink:
    enabled = (
        not no_color
        and sys.stdout.isatty()
        and os.environ.get("NO_COLOR") is None
    )
    return Ink(enabled)


# ---------------------------------------------------------------------------
# Narration helpers — all output goes through these for a consistent look.
# ---------------------------------------------------------------------------

_WIDTH = 78


def _rule(ink: Ink, char: str = "─") -> None:
    print(ink.dim(char * _WIDTH))


def _banner(ink: Ink, title: str) -> None:
    """A boxed top-level banner."""
    print()
    print(ink.header("╔" + "═" * (_WIDTH - 2) + "╗"))
    inner = title.center(_WIDTH - 2)
    print(ink.header("║") + ink.header(ink.bold(inner)) + ink.header("║"))
    print(ink.header("╚" + "═" * (_WIDTH - 2) + "╝"))


def _step(ink: Ink, n: str, title: str) -> None:
    """A numbered pipeline step header (blue) with a rule under it."""
    print()
    print(ink.sys(f"━━ STEP {n} ─ {title} ").ljust(_WIDTH))
    _rule(ink)


def _substep(ink: Ink, label: str) -> None:
    print(ink.sys(f"  ▸ {label}"))


def _agent_says(ink: Ink, name: str, text: str) -> None:
    print(f"    {ink.agent('🤖 ' + name)}: {text}")


def _user_says(ink: Ink, name: str, text: str) -> None:
    print(f"    {ink.user('🗣  ' + name)}: {ink.user(text)}")


def _db_line(ink: Ink, text: str) -> None:
    print(f"    {ink.db('🗄  DB')}  {ink.db(text)}")


def _note(ink: Ink, text: str) -> None:
    print(f"    {ink.dim('· ' + text)}")


def _kv(ink: Ink, key: str, value: str) -> None:
    print(f"      {ink.dim(key + ':'):<28} {value}")


# ---------------------------------------------------------------------------
# Mock group — WHO the users are + what they "say" to their preference agent.
# ---------------------------------------------------------------------------
#
# Four deliberately DIVERGENT diners so the orchestrator's reconcile step does
# real work (dietary union, budget-min cap, cuisine weighting) rather than
# trivially agreeing — the same design idea as smoke_orchestrator, expanded to
# four so the top-5 is a genuine selection among many valid candidates.
#
# Each member carries a scripted `qa_turns` dialogue (agent question -> spoken
# answer). Those spoken answers map onto the structured Profile fields below;
# `normalize_member` (the real agent) then produces the MemberPref from the
# structured fields — exactly as it will from real saved profiles in prod.

MockMember = dict[str, Any]

# Each member has a durable `profile` (their saved Profile columns — the pipeline
# fan-out reads these, and dietary_restrictions hard-filters from HERE since Qa
# has no dietary column) and a scripted `analyze_turns` conversation with their
# QA sub-agent. Every turn is (agent_question, spoken_answer, offline_delta):
#   * agent_question / spoken_answer — narration; the answer is what --live sends
#     verbatim to the real gateway.
#   * offline_delta — a compact description of what the OFFLINE LLM stand-in
#     "extracts" from that answer, in the analyze-turn JSON contract's terms.
#     The REAL analyze_turn then runs its reconcile/expand/removal/reply logic
#     over it, so cuisine GROUPS expand ("asian" -> its members), STYLES are
#     recorded ("steakhouse"), and corrections/adds/removals apply for real.
# Delta keys (all optional): preferred / disliked / dietary (ADD these terms);
#   set_preferred / set_disliked (REPLACE the list — a correction); remove_*
#   (drop these terms); budget_min / budget_max (ints). Cuisines here are the
#   member's SESSION overrides (-> their Qa row's qa_* fields); dietary is asked
#   for realism but is NOT persisted to Qa (it lives on the durable Profile).
_MEMBERS: list[MockMember] = [
    {
        "username": "demo_alice",
        "display_name": "Alice",
        "persona": "host; comfort-food fan, speaks in broad strokes + changes her mind",
        "profile": {
            "user_id": 1,
            "dietary_restrictions": [],
            "preferred_cuisines": ["thai"],  # durable baseline; QA adds/overrides
            "disliked_cuisines": [],
            "budget_min": 15,
            "budget_max": 40,
            "liked_restaurant_ids": [],
        },
        # The feature-spec showcase: a broad-group answer ("German and American"),
        # then a cross-question ADD ("also add steakhouse") while answering the
        # avoid question, then a budget.
        "analyze_turns": [
            ("Hi Alice! First — any dietary needs I should lock in for the group?",
             "Don't have any.",
             {"dietary": []}),
            ("Which cuisines make you happiest? What sounds good today?",
             "German and American food.",
             {"preferred": ["german", "american"]}),
            ("Anything you'd rather the group avoided tonight?",
             "I'd like to avoid Chinese. Also add steakhouse as a preference for me.",
             {"disliked": ["chinese"], "preferred": ["steakhouse"]}),
            ("Sure thing, I updated your preferences. Your comfortable price per person?",
             "Let's do $20.",
             {"budget_max": 20}),
        ],
    },
    {
        "username": "demo_bob",
        "display_name": "Bob",
        "persona": "budget-tight, talks in broad cravings ('something Asian')",
        "profile": {
            "user_id": 2,
            "dietary_restrictions": [],
            "preferred_cuisines": ["mexican"],
            "disliked_cuisines": [],
            "budget_min": 8,
            "budget_max": 20,
            "liked_restaurant_ids": [],
        },
        # Broad cuisine GROUP ("Asian") + a STYLE dislike ("nothing fine-dining")
        # + a PREFERRED LOCATION relative to the host (a spot closer to Bob), which
        # becomes the secondary anchor for the between-host-and-member ranking.
        "analyze_turns": [
            ("Hey Bob — any dietary restrictions?",
             "Nope, I'll eat anything.",
             {"dietary": []}),
            ("What are you craving?",
             "Honestly something Asian sounds great right now.",
             {"preferred": ["asian"]}),
            ("Anything off the table?",
             "Nothing fancy — skip the fine-dining spots, I'm on a budget.",
             {"disliked": ["fine_dining"]}),
            ("What's your budget per head?",
             "Keep it under $20.",
             {"budget_max": 20}),
            ("The host set the spot around downtown SF — anywhere more convenient "
             "for you, or is that good?",
             "I'm over by the Mission, could we lean that way?",
             {"location_label": "Mission District, San Francisco",
              "location_mode": "named",
              "location_lat": 37.7599, "location_lon": -122.4148}),
        ],
    },
    {
        "username": "demo_carol",
        "display_name": "Carol",
        "persona": "adventurous, but changes her mind mid-conversation",
        "profile": {
            "user_id": 3,
            "dietary_restrictions": [],
            "preferred_cuisines": ["italian"],
            "disliked_cuisines": [],
            "budget_min": 20,
            "budget_max": 60,
            "liked_restaurant_ids": [],
        },
        # Broad group ("Mediterranean") then a CORRECTION that REPLACES it with a
        # style ("actually make it a seafood spot") — proves the reconcile drops
        # the whole prior group when the user changes their mind.
        "analyze_turns": [
            ("Carol, any dietary needs on your end?",
             "No restrictions here.",
             {"dietary": []}),
            ("Favorite cuisines? What sounds good?",
             "Let's do Mediterranean food.",
             {"preferred": ["mediterranean"]}),
            ("Mediterranean it is. Anything else, or shall we lock cuisines in?",
             "Actually, change that — I'd rather do a good seafood place instead.",
             {"set_preferred": ["seafood"],
              "remove_preferred": ["mediterranean"]}),
            ("Got it, seafood instead. Your budget range?",
             "I'm flexible — up to $60.",
             {"budget_max": 60}),
        ],
    },
    {
        "username": "demo_dan",
        "display_name": "Dan",
        "persona": "vegetarian (from profile); likes Italian, adds a style",
        "profile": {
            "user_id": 4,
            "dietary_restrictions": ["vegetarian"],  # HARD filter, from Profile
            "preferred_cuisines": ["indian"],
            "disliked_cuisines": [],
            "budget_min": 12,
            "budget_max": 35,
            "liked_restaurant_ids": [],
        },
        # Dietary comes from the durable Profile (hard filter for the whole group);
        # session adds a cuisine + a STYLE ("add pizza"), and a style dislike.
        "analyze_turns": [
            ("Dan, any dietary needs?",
             "I'm vegetarian — already on my profile.",
             {"dietary": ["vegetarian"]}),
            ("Which cuisines are you feeling?",
             "Italian, and add a pizza place to the mix.",
             {"preferred": ["italian", "pizza"]}),
            ("Anything you'd skip?",
             "I'll pass on heavy BBQ tonight.",
             {"disliked": ["bbq"]}),
            ("And your budget?",
             "Around $12 to $35.",
             {"budget_min": 12, "budget_max": 35}),
        ],
    },
]

# Group session setup — the host answers the session-level questions. These map
# onto the `Qa` row the real app persists per session (occasion/location/budget/
# time-slot). Centered on downtown SF with a generous radius so the geo bounding
# box does not exclude the seed cluster.
_SESSION_QA_TURNS: list[tuple[str, str]] = [
    ("What's the occasion?", "Casual group dinner with friends."),
    ("Where should we look, and how far out?",
     "Around downtown San Francisco, within about 10 miles."),
    ("What time slot?", "Dinner, tonight."),
]

# Session-level (host-authored) signals only. NOTE: budget is per-MEMBER (each
# member states their own in their analyze conversation → their Qa budget cap);
# there is no session-level budget on QaSignals, so none is set here.
_SESSION_QA = QaSignals(
    occasion="casual group dinner",
    location_mode="manual",
    location_lat=37.7749,   # downtown San Francisco (matches the seed cluster)
    location_lon=-122.4194,
    radius_miles=10.0,
)

_DEMO_SESSION_ID = 9001  # cosmetic only — offline mode never touches the DB.

# The host's chosen event time (would be Session.scheduled_for). A fixed Monday
# 7pm so the open/closed hard filter is deterministic run-to-run (scripts cannot
# call datetime.now()). Most seed dinner spots are open at this time; lunch-only
# spots get filtered out, demonstrating the hours hard filter.
_DEMO_SCHEDULED_FOR = datetime(2026, 7, 13, 19, 0)  # Mon 7:00pm

# Set once in _run: when False (offline), each analyze_turn call is fed a scripted
# LLM completion; when True (--live), analyze_turn hits the real gateway. Threaded
# as a module global so the reused-by-interactive_session narration helpers don't
# each need a `live` parameter.
_LIVE_MODE = False


# ---------------------------------------------------------------------------
# Offline mock providers (embed / retrieve / re-rank).
#
# These stand in for the three network/DB calls the real orchestrator makes.
# They are deterministic (no random, no clock) so every run is identical, and
# they reuse the REAL seed catalog so offline retrieval filters over the exact
# same restaurants a live DB would hold.
# ---------------------------------------------------------------------------

# Approximate miles-per-degree constant — copied from ai/rag/retriever.py so the
# offline bounding-box geo filter matches the SQL filter exactly.
_MILES_PER_DEG_LAT = 69.0


@dataclass
class _MockRestaurant:
    """Lightweight stand-in exposing the attributes orchestrate() reads."""

    id: int
    name: str
    cuisine_tags: list[str] = field(default_factory=list)
    dietary_tags: list[str] = field(default_factory=list)
    price_avg: float | None = None
    avg_rating: float | None = None
    lat: float | None = None
    long: float | None = None
    hours: str | None = None


def _load_mock_catalog() -> list[_MockRestaurant]:
    """Build the offline catalog from the real seed rows (assigning ids 1..N)."""
    # Reuse the exact hand-authored seed list — a pure function, no DB/network.
    from scripts.seed_restaurants import _mock_restaurants

    catalog: list[_MockRestaurant] = []
    for idx, row in enumerate(_mock_restaurants(), start=1):
        catalog.append(
            _MockRestaurant(
                id=idx,
                name=row["name"],
                cuisine_tags=list(row["cuisine_tags"]),
                dietary_tags=list(row["dietary_tags"]),
                price_avg=row["price_avg"],
                avg_rating=row["avg_rating"],
                lat=row["lat"],
                long=row["long"],
                hours=row.get("hours"),
            )
        )
    return catalog


def _mock_embed(text: str, dims: int = 1024) -> list[float]:
    """Deterministic pseudo-embedding from a text hash (no network, no random).

    Not semantically meaningful — it exists so the narration can show a concrete
    1024-dim vector. Offline retrieval ranks by a preference-affinity score
    (below), not by this vector, which is what keeps the top-5 sensible.
    """
    digest = hashlib.sha256(text.encode("utf-8")).digest()
    # Expand the 32-byte digest into `dims` floats in [-1, 1], cycling bytes.
    return [((digest[i % len(digest)] / 255.0) * 2.0) - 1.0 for i in range(dims)]


def _affinity(
    r: _MockRestaurant, reconciled: ReconciledConstraints
) -> float:
    """Preference-affinity score in [0, 1] for offline ranking / re-rank.

    Blends reconciled cuisine weights (tanh-squashed), rating, and price fit.
    Mirrors, in spirit, what the LLM re-rank optimizes for so the offline top-5
    reads like a real recommendation. Higher = better; distance = 1 - score.
    """
    weight_sum = sum(
        reconciled.cuisine_weights.get(tag, 0.0) for tag in r.cuisine_tags
    )
    cuisine_score = (math.tanh(weight_sum / 2.0) + 1.0) / 2.0  # 0..1

    rating = r.avg_rating if r.avg_rating is not None else 3.5
    rating_score = max(0.0, min(1.0, (rating - 3.5) / (5.0 - 3.5)))

    # Budget is a soft CEILING: at or under everyone's cap costs nothing, and it
    # only decays past the tightest one. Mirrors orchestrator_agent's
    # _group_budget_fit so the offline stand-in ranks the way the real path does.
    price_score = _group_budget_fit(r.price_avg, reconciled.member_budget_caps)
    if price_score is None:
        price_score = 1.0

    raw = 0.55 * cuisine_score + 0.30 * rating_score + 0.15 * price_score
    return round(max(0.0, min(1.0, raw)), 4)


def _mock_similarity_search(
    catalog: list[_MockRestaurant],
    reconciled: ReconciledConstraints,
    *,
    limit: int,
) -> list[tuple[_MockRestaurant, float]]:
    """Offline pgvector stand-in: apply the SAME hard filters, then rank.

    Mirrors ai/rag/retriever.similarity_search's WHERE clauses (dietary superset
    `@>`, price cap, geo bounding box) so the candidate set matches what the live
    SQL query would return, then orders ascending by (1 - affinity) as a proxy
    for cosine distance.
    """
    required = set(reconciled.required_dietary or [])
    hits: list[tuple[_MockRestaurant, float]] = []

    # Precompute the geo bounding box once (matches retriever.py math).
    box: tuple[float, float, float, float] | None = None
    if reconciled.center is not None and reconciled.radius_miles is not None:
        lat, lon = reconciled.center
        lat_delta = reconciled.radius_miles / _MILES_PER_DEG_LAT
        cos_lat = math.cos(math.radians(lat))
        lon_scale = _MILES_PER_DEG_LAT * max(abs(cos_lat), 1e-6)
        lon_delta = reconciled.radius_miles / lon_scale
        box = (lat - lat_delta, lat + lat_delta, lon - lon_delta, lon + lon_delta)

    for r in catalog:
        # dietary_tags must be a superset of the required tags (`@>`).
        if required and not required.issubset(set(r.dietary_tags)):
            continue
        # Retrieval price ceiling — a RECALL guardrail (tightest cap plus
        # headroom), not the group's budget. Budget itself is soft and applied at
        # ranking time via budget_fit.
        if reconciled.retrieval_price_ceiling is not None:
            if r.price_avg is None or r.price_avg > reconciled.retrieval_price_ceiling:
                continue
        # geo bounding box.
        if box is not None:
            if r.lat is None or r.long is None:
                continue
            lat_lo, lat_hi, lon_lo, lon_hi = box
            if not (lat_lo <= r.lat <= lat_hi and lon_lo <= r.long <= lon_hi):
                continue

        distance = round(1.0 - _affinity(r, reconciled), 4)
        hits.append((r, distance))

    hits.sort(key=lambda pair: pair[1])  # ascending distance (nearest first)
    return hits[:limit]


def _mock_rerank_response(
    candidates: list[CandidateRestaurant], reconciled: ReconciledConstraints
) -> str:
    """Produce the strict-JSON array the LLM re-rank *would* return.

    Scores each candidate with the same affinity heuristic, sorts best-first, and
    writes a one-sentence justification referencing the matched cuisines/dietary/
    price. The real `_parse_ranked` then validates this exactly as it validates a
    genuine Claude response — so the offline path exercises real parsing.
    """
    preferred = {c for c, w in reconciled.cuisine_weights.items() if w > 0}
    required = set(reconciled.required_dietary or [])

    scored: list[tuple[CandidateRestaurant, float]] = []
    for c in candidates:
        r = _MockRestaurant(
            id=c.id,
            name=c.name,
            cuisine_tags=c.cuisine_tags,
            dietary_tags=c.dietary_tags,
            price_avg=c.price_avg,
            avg_rating=c.avg_rating,
        )
        scored.append((c, _affinity(r, reconciled)))
    scored.sort(key=lambda pair: pair[1], reverse=True)

    entries: list[dict[str, Any]] = []
    for c, score in scored:
        matched_cuisines = [t for t in c.cuisine_tags if t in preferred]
        matched_dietary = [t for t in c.dietary_tags if t in required]
        bits: list[str] = []
        if matched_cuisines:
            bits.append(f"hits the group's {', '.join(matched_cuisines)} craving")
        if matched_dietary:
            bits.append(f"is {', '.join(matched_dietary)}-friendly")
        if c.price_avg is not None:
            bits.append(f"lands at ~${c.price_avg:.0f}/person")
        justification = (
            f"{c.name} " + (", ".join(bits) if bits else "fits the group's brief")
            + "."
        )
        entries.append(
            {
                "restaurant_id": c.id,
                "match_score": round(score, 3),
                "justification": justification,
            }
        )
    return json.dumps(entries, ensure_ascii=False, indent=2)


# ---------------------------------------------------------------------------
# The narrated flow.
# ---------------------------------------------------------------------------


def _print_intro(ink: Ink, live: bool) -> None:
    _banner(ink, "GrubGroup · Group Recommendation Pipeline — Terminal Demo")
    mode = ink.warn("LIVE (real DB + embeddings + Claude)") if live else ink.good(
        "OFFLINE MOCK (no DB, no API keys, deterministic)"
    )
    print(f"  Mode: {mode}")
    print(
        "  "
        + ink.dim(
            "This traces what happens when a group each talks to their own AI "
            "preference\n  agent and a master orchestrator picks restaurants for "
            "everyone. It is the\n  terminal preview of the flow the frontend will "
            "drive with real voice input."
        )
    )
    if not live:
        _note(
            ink,
            "Real logic runs: analyze_turn (parse/expand/reconcile), "
            "normalize_member, _reconcile,",
        )
        _note(ink, "  _build_query_text, _parse_ranked over the real seed catalog; "
                   "only the analyze LLM,")
        _note(ink, "  embed, pgvector, and re-rank LLM are swapped for "
                   "deterministic stand-ins.")


def _print_roster(ink: Ink) -> None:
    _step(ink, "1/6", "THE GROUP (who is in this session)")
    print(f"    {ink.dim('Session id (demo):')} {_DEMO_SESSION_ID}   "
          f"{ink.dim('members:')} {len(_MEMBERS)}")
    print()
    for i, m in enumerate(_MEMBERS, start=1):
        host = ink.dim("  (host)") if i == 1 else ""
        print(f"    {i}. {ink.user(ink.bold(m['display_name']))} "
              f"{ink.dim('@' + m['username'])}{host}")
        print(f"       {ink.dim(m['persona'])}")


def _print_session_qa(ink: Ink) -> None:
    _step(ink, "2/6", "GROUP SESSION SETUP (host answers session Q&A → Qa row)")
    _note(ink, "In production these become the session's `Qa` row "
               "(occasion / location / budget / time).")
    print()
    host = _MEMBERS[0]["display_name"]
    for q, a in _SESSION_QA_TURNS:
        _agent_says(ink, "Session Agent", q)
        _user_says(ink, host, a)
    print()
    _substep(ink, "Parsed session signals (QaSignals — host-only occasion + location):")
    _kv(ink, "occasion", str(_SESSION_QA.occasion))
    _kv(ink, "location", f"({_SESSION_QA.location_lat}, {_SESSION_QA.location_lon}) "
                         f"mode={_SESSION_QA.location_mode}")
    _kv(ink, "radius_miles", str(_SESSION_QA.radius_miles))
    _note(ink, "budget is per-member (each states their own in their QA chat), "
               "not a session field. The event time lives on Session.scheduled_for, "
               "not QaSignals.")


def _offline_completion_for(
    delta: dict[str, Any], current: ExtractedSignals
) -> str:
    """Build the strict-JSON an LLM *would* return for one scripted turn.

    Stands in for the analyze-turn model call in offline mode: it applies the
    turn's `offline_delta` to the running signals in RAW-term space (add / set /
    remove on the small spoken-term lists) and returns the analyze-turn JSON
    contract. The REAL `analyze_turn` then runs its own reconcile — group/style
    EXPANSION, removal enforcement, dedupe, reply + missing computation — over
    this, so the offline path exercises the actual agent logic (only the model's
    text is scripted). Mirrors ``analyze_turn_demo._install_offline_llm``.
    """
    signals: dict[str, Any] = {}

    # preferred_cuisines: set_ REPLACES (a correction), else ADD onto the prior.
    if "set_preferred" in delta:
        signals["preferred_cuisines"] = list(delta["set_preferred"])
    elif "preferred" in delta:
        signals["preferred_cuisines"] = list(current.preferred_cuisines) + list(
            delta["preferred"]
        )
    if "set_disliked" in delta:
        signals["disliked_cuisines"] = list(delta["set_disliked"])
    elif "disliked" in delta:
        signals["disliked_cuisines"] = list(current.disliked_cuisines) + list(
            delta["disliked"]
        )
    if "dietary" in delta:
        signals["dietary_restrictions"] = list(delta["dietary"])

    # Explicit per-turn removals (the belt-and-suspenders correction signal).
    if "remove_preferred" in delta:
        signals["removed_preferred"] = list(delta["remove_preferred"])
    if "remove_disliked" in delta:
        signals["removed_disliked"] = list(delta["remove_disliked"])

    for key in ("budget_min", "budget_max"):
        if key in delta:
            signals[key] = delta[key]

    # Location: a member's preferred spot (the secondary ranking anchor). The
    # label + optional coords stand in for what the LLM would extract; the real
    # analyze_turn maps location_label -> Qa.location_address and (live) geocodes,
    # while offline we pass explicit coords so ranking has something to work with.
    for key in ("location_label", "location_mode", "location_lat", "location_lon"):
        if key in delta:
            signals[key] = delta[key]

    # No agent_reply / missing_signals here on purpose — let the REAL analyze_turn
    # generate them (its confirm-then-ask fallback + missing computation), so the
    # narrated reply and the group-summary of an expanded cuisine list are real.
    return json.dumps({"extracted_signals": signals})


def _install_offline_turn(delta: dict[str, Any], current: ExtractedSignals) -> None:
    """Patch conversation_agent.chat_completion to return this turn's canned JSON.

    One-shot per turn: analyze_turn calls chat_completion exactly once, so we
    swap in a closure returning the JSON for this specific turn right before the
    call. Live mode never installs this — it uses the real gateway.
    """
    canned = _offline_completion_for(delta, current)

    async def _scripted(messages, **kwargs):  # noqa: ANN001, ARG001
        return canned

    conversation_agent.chat_completion = _scripted


def _build_member_pref(
    profile: dict[str, Any], signals: ExtractedSignals
) -> dict[str, Any]:
    """Assemble the merged Profile+Qa dict the pipeline feeds into normalize_member.

    Mirrors ``pipeline.run_pipeline`` exactly: the durable Profile columns are
    the base, and the session's reconciled signals become the ``qa_*`` overrides
    via the REAL ``profile_service.qa_diff`` split. Returns the plain merged dict
    (``normalize_member`` accepts a dict) — the caller normalizes it into the real
    MemberPref. Crucially, dietary is taken from the durable Profile, NOT from the
    QA turn — the Qa table has no dietary column (``qa_diff`` omits it), so dietary
    hard-filters from Profile while cuisines/budget are the session override. This
    is the production contract.
    """
    from app.services import profile_service

    qa = profile_service.qa_diff(signals)
    merged = {
        **profile,
        "qa_preferred_cuisines": qa.get("preferred_cuisines", []),
        "qa_disliked_cuisines": qa.get("disliked_cuisines", []),
        "qa_budget_min": qa.get("budget_min"),
        "qa_budget_max": qa.get("budget_max"),
        # A member's preferred location becomes the SECONDARY anchor the
        # orchestrator ranks between host and member on. Offline the coords come
        # straight from the scripted signals (live, persist_qa geocodes the label).
        "qa_location_lat": qa.get("location_lat"),
        "qa_location_lon": qa.get("location_lon"),
    }
    return merged


async def _print_preference_agents(ink: Ink) -> list[MemberPref]:
    """Narrate each member's REAL QA sub-agent conversation; return normalized prefs.

    This is the pipeline's fan-out step: one preference sub-agent per member. Each
    member's spoken answers are driven through the REAL
    ``conversation_agent.analyze_turn`` (offline: a scripted per-turn LLM stand-in;
    --live: the real Salesforce/Claude gateway), so arbitrary wording, broad
    cuisine GROUPS, restaurant STYLES, and mid-conversation corrections/adds/
    removals are all parsed by production code. The reconciled per-member signals
    become that member's Qa overrides (``qa_*``), merged over their durable
    Profile exactly as ``pipeline.run_pipeline`` does, then normalized via the
    REAL ``normalize_member``. Sequential here for readable output; the live graph
    fans out concurrently and converges via the additive ``members`` reducer.
    """
    _step(ink, "3/6", "PREFERENCE SUB-AGENTS (fan-out: one analyze_turn agent per member)")
    _note(ink, "Each diner talks to conversation_agent.analyze_turn(); answers are "
               "parsed into")
    _note(ink, "reconciled signals → the member's Qa override, merged over their "
               "durable Profile.")
    _note(ink, "Broad terms expand (asian → its cuisines), styles are captured "
               "(steakhouse), and")
    _note(ink, "corrections/adds/removals apply live. Dietary hard-filters from "
               "Profile (Qa has none).")

    from app.services import profile_service

    prefs: list[MemberPref] = []
    for i, m in enumerate(_MEMBERS):
        name = m["display_name"]
        is_host = i == 0
        print()
        _rule(ink, "·")
        role = ink.dim(" (host)") if is_host else ""
        print(f"    {ink.agent(ink.bold('▷ Preference sub-agent for ' + name))}{role} "
              f"{ink.dim('(' + m['persona'] + ')')}")
        print()

        signals = ExtractedSignals()
        history: list[ConversationTurn] = []
        for question, answer, delta in m["analyze_turns"]:
            _agent_says(ink, f"{name}'s Agent", question)
            _user_says(ink, name, answer)

            if not _LIVE_MODE:
                _install_offline_turn(delta, signals)

            result = await analyze_turn(
                answer,
                current_signals=signals,
                conversation_history=history,
                is_host=is_host,
            )
            signals = result.signals
            # The agent's real confirm-then-ask reply (or graceful fallback).
            print(f"    {ink.dim('↳ agent:')} {ink.dim(result.agent_reply)}")
            history += [
                ConversationTurn(role="user", content=answer),
                ConversationTurn(role="assistant", content=result.agent_reply),
            ]

        # What the service would persist for this member's session (the Qa row).
        qa = profile_service.qa_diff(signals)
        print()
        _substep(ink, f"RECONCILED SESSION SIGNALS → {name}'s Qa override:")
        _kv(ink, "preferred_cuisines", _fmt_tags(signals.preferred_cuisines))
        _kv(ink, "disliked_cuisines", _fmt_tags(signals.disliked_cuisines))
        _kv(ink, "budget (min/max)",
            f"${qa.get('budget_min')} / ${qa.get('budget_max')}")
        _note(ink, f"dietary (from durable Profile, NOT Qa): "
                   f"{m['profile']['dietary_restrictions'] or '[]'}")

        # Merge Profile + Qa overrides exactly like the pipeline, then normalize.
        merged = _build_member_pref(m["profile"], signals)
        pref = await normalize_member(merged)
        prefs.append(pref)

        _substep(ink, f"NORMALIZED MemberPref for {name} (Profile + Qa overrides):")
        _kv(ink, "dietary_restrictions (HARD)", str(pref.dietary_restrictions) or "[]")
        _kv(ink, "preferred (profile)", str(pref.preferred_cuisines))
        _kv(ink, "qa_preferred (override)", _fmt_tags(pref.qa_preferred_cuisines))
        _kv(ink, "qa_disliked (override)", _fmt_tags(pref.qa_disliked_cuisines))
        cap = pref.effective_budget_cap
        _kv(
            ink,
            "effective budget ceiling",
            f"${cap}" if cap is not None else "none (flexible / no data)",
        )
        print(f"    {ink.agent('✔ END OF SUB-AGENT CONVERSATION for ' + name)}")

    return prefs


def _fmt_tags(tags: list[str], *, limit: int = 8) -> str:
    """Compact list rendering so an expanded cuisine group stays readable."""
    if len(tags) <= limit:
        return str(tags)
    return f"[{', '.join(repr(t) for t in tags[:limit])}, … +{len(tags) - limit}]"


def _print_reconcile(
    ink: Ink, state: PipelineState
) -> ReconciledConstraints:
    """Run + narrate the orchestrator's reconcile step (the real `_reconcile`)."""
    _step(ink, "4/6", "MASTER ORCHESTRATOR — reconcile the whole group")
    _note(ink, "Union all dietary needs (HARD), collect each member's budget "
               "CEILING (soft — scored, never filtered), and weight cuisines")
    _note(ink, "(preferred +1 each, disliked −1 each), summed across members.")

    reconciled = _reconcile(state)
    print()
    _substep(ink, "Reconciled group constraints:")
    _kv(ink, "required_dietary (HARD)", ink.warn(str(reconciled.required_dietary)))
    caps = reconciled.member_budget_caps
    _kv(
        ink,
        "member_budget_caps (SOFT)",
        ink.warn(str([f"${c}" for c in caps]) if caps else "[] (nobody capped)"),
    )
    ceiling = reconciled.retrieval_price_ceiling
    _kv(
        ink,
        "retrieval ceiling (recall only)",
        "none" if ceiling is None else f"${ceiling:.0f}",
    )
    _kv(ink, "center / radius",
        f"{reconciled.center} / {reconciled.radius_miles} mi")
    _kv(ink, "host anchor (primary)", str(reconciled.host_location))
    _kv(ink, "member anchors (secondary)",
        str(reconciled.member_locations) or "[]")
    # Show cuisine weights sorted most-preferred first.
    weights = sorted(
        reconciled.cuisine_weights.items(), key=lambda kv: kv[1], reverse=True
    )
    pretty = ", ".join(f"{c}:{w:+.0f}" for c, w in weights)
    _kv(ink, "cuisine_weights", pretty or "{}")
    return reconciled


async def _print_orchestrate_and_rank(
    ink: Ink,
    state: PipelineState,
    reconciled: ReconciledConstraints,
    *,
    live: bool,
    top_n: int,
) -> list[tuple[RankedItem, CandidateRestaurant]]:
    """Narrate build-query → embed → retrieve → LLM re-rank → final ranking.

    Mirrors ``orchestrator_agent.orchestrate`` step for step, swapping the three
    providers for offline mocks unless ``live`` is set. Returns the ranked items
    paired with their candidate payloads (for the final printout).
    """
    # --- 4a. Build the retrieval query text (real helper) -------------------
    _step(ink, "5/6", "MASTER ORCHESTRATOR — retrieve candidates (RAG) + re-rank")
    query_text = _build_query_text(reconciled, state)
    _substep(ink, "Built natural-language retrieval query:")
    print(f"      {ink.dim(query_text)}")

    # --- 4b. Embed the query ------------------------------------------------
    print()
    if live:
        _substep(ink, "Embedding query via OpenRouter (Qwen3, 1024-dim) …")
        from app.ai.rag.embeddings import embed_text

        query_embedding = await embed_text(query_text)
    else:
        _substep(ink, "Embedding query (offline deterministic stand-in, 1024-dim) …")
        query_embedding = _mock_embed(query_text)
    preview = ", ".join(f"{v:+.3f}" for v in query_embedding[:8])
    _kv(ink, "embedding.len", str(len(query_embedding)))
    _kv(ink, "embedding[:8]", f"[{preview}, …]")

    # --- 4c. Retrieve from the restaurant DB (pgvector) ---------------------
    print()
    _db_line(ink, "ACCESS DATABASE → pgvector similarity_search (cosine `<=>`)")
    _db_line(ink, "hard filters pushed into SQL: dietary superset `@>`, "
                  "price cap, geo box")
    if live:
        from app.ai.rag.retriever import similarity_search

        hits = await similarity_search(
            query_embedding,
            limit=_CANDIDATE_LIMIT,
            required_dietary_tags=reconciled.required_dietary or None,
            price_max=reconciled.retrieval_price_ceiling,
            center=reconciled.center,
            radius_miles=reconciled.radius_miles,
        )
    else:
        catalog = _load_mock_catalog()
        _db_line(ink, f"(offline) scanning mock seed catalog of {len(catalog)} "
                      f"restaurants")
        hits = _mock_similarity_search(catalog, reconciled, limit=_CANDIDATE_LIMIT)

    # Build candidates via the REAL orchestrator helper: it attaches each
    # candidate's proximity tier (between-host-and-member > host > member > far)
    # and open/closed status at the event time, and HARD-FILTERS confidently-
    # closed venues out — the exact geo/hours logic the live pipeline runs.
    from app.ai.agents.orchestrator_agent import _build_candidates

    n_before = len(hits)
    candidates = _build_candidates(hits, reconciled, state)
    dropped = n_before - len(candidates)
    _db_line(ink, f"retrieved {n_before} candidate(s); hours hard-filter dropped "
                  f"{dropped} closed at the event time, leaving {len(candidates)}:")
    for c in candidates:
        dist = f"{c.distance:.4f}" if c.distance is not None else "n/a"
        openflag = {True: "open", False: "closed", None: "hours?"}[c.is_open]
        print(f"        {ink.db('•')} {c.name}  "
              f"{ink.dim(f'[{', '.join(c.cuisine_tags)}]')}  "
              f"{ink.dim(f'~${c.price_avg:.0f}' if c.price_avg else '')}  "
              f"{ink.dim('dist=' + dist)}  "
              f"{ink.dim('tier=' + (c.proximity_tier or '-'))}  "
              f"{ink.dim(openflag)}")
    print(f"    {ink.db('✔ END OF DATABASE ACCESS')}")

    if not candidates:
        _note(ink, "No restaurants passed the hard filters — the pipeline yields "
                   "an empty result.")
        return []

    # --- 4d. LLM re-rank ----------------------------------------------------
    print()
    messages = build_group_rerank_messages(
        # Same exclusion the real orchestrator applies — retrieval_price_ceiling
        # is a recall guardrail, and showing it invites the model to read it as a
        # budget the group agreed to.
        reconciled=reconciled.model_dump(exclude={"retrieval_price_ceiling"}),
        candidates=[c.model_dump() for c in candidates],
    )
    if live:
        _substep(ink, "Calling the LLM re-rank (Salesforce gateway → Claude, "
                      "temperature=0.2) …")
        from app.ai.llm.client import chat_completion

        raw = await chat_completion(messages, temperature=0.2) or ""
    else:
        _substep(ink, "LLM re-rank (offline stand-in emitting the strict-JSON "
                      "Claude would return) …")
        raw = _mock_rerank_response(candidates, reconciled)
    _note(ink, f"raw model response ({len(raw)} chars) — validated by the REAL "
               f"_parse_ranked:")
    for line in raw.strip().splitlines()[:14]:
        print(f"        {ink.dim(line)}")
    if len(raw.strip().splitlines()) > 14:
        print(f"        {ink.dim('… (truncated)')}")

    # --- Real parsing + real proximity/budget blend + distance-ranked fallback -
    from app.ai.agents.orchestrator_agent import _blend_score

    valid_ids = {c.id for c in candidates}
    tier_by_id = {c.id: c.proximity_tier for c in candidates}
    fit_by_id = {c.id: c.budget_fit for c in candidates}
    ranked = _parse_ranked(raw, valid_ids)
    if ranked:
        _substep(ink, f"_parse_ranked accepted {len(ranked)} of "
                      f"{len(candidates)} candidates; blending proximity tiers "
                      f"and the soft budget penalty.")
        for item in ranked:
            item.match_score = _blend_score(
                item.match_score,
                tier_by_id.get(item.restaurant_id),
                fit_by_id.get(item.restaurant_id),
            )
        ranked.sort(key=lambda item: item.match_score, reverse=True)
    else:
        # Same fallback the real orchestrator uses when the LLM returns nothing
        # parseable — rank by retrieval distance + proximity + budget so we still
        # emit valid, geometry- and budget-aware output.
        _substep(ink, ink.warn("LLM returned nothing parseable → "
                               "distance+proximity+budget FALLBACK engaged."))
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
                justification="Ranked by embedding similarity + proximity + "
                              "budget fit (LLM re-rank unavailable).",
            )
            for c in ordered
        ]
        ranked.sort(key=lambda item: item.match_score, reverse=True)

    by_id = {c.id: c for c in candidates}
    return [(item, by_id[item.restaurant_id]) for item in ranked]


def _print_top_picks(
    ink: Ink,
    ranked: list[tuple[RankedItem, CandidateRestaurant]],
    *,
    top_n: int,
) -> None:
    _step(ink, "6/6", f"FINAL RESULT — the orchestrator's TOP {top_n} for the group")
    if not ranked:
        _note(ink, "(empty) — no picks were produced.")
        return

    _note(ink, f"Full ranking has {len(ranked)} restaurant(s); showing the "
               f"top {min(top_n, len(ranked))}.")
    print()
    for rank, (item, cand) in enumerate(ranked[:top_n], start=1):
        medal = {1: "🥇", 2: "🥈", 3: "🥉"}.get(rank, f" {rank}.")
        print(f"    {ink.good(medal)} {ink.good(ink.bold(cand.name))}  "
              f"{ink.dim(f'[match {item.match_score:.2f}]')}")
        tags = ", ".join(cand.cuisine_tags)
        diet = ", ".join(cand.dietary_tags) or "—"
        price = f"~${cand.price_avg:.0f}" if cand.price_avg is not None else "n/a"
        rating = f"{cand.avg_rating:.1f}★" if cand.avg_rating is not None else "n/a"
        print(f"        {ink.dim('cuisine:')} {tags}")
        print(f"        {ink.dim('dietary:')} {diet}   "
              f"{ink.dim('price:')} {price}   {ink.dim('rating:')} {rating}")
        print(f"        {ink.dim('why:')} {item.justification}")
        print()


def _print_outro(ink: Ink, live: bool) -> None:
    _rule(ink)
    print(f"  {ink.good('✔ DONE.')} "
          + ink.dim("This is the terminal preview of the group recommendation "
                    "flow."))
    if not live:
        print("  " + ink.dim(
            "When wired to the frontend, the scripted answers above are replaced "
            "by real\n  voice/text input, the mock catalog by the seeded Postgres "
            "restaurants, and the\n  offline stand-ins by real OpenRouter "
            "embeddings + Claude re-rank. Run --live to\n  exercise that real path "
            "(needs a running DB + API keys, like the smoke test)."
        ))
    print()


# ---------------------------------------------------------------------------
# Live-mode preflight (only relevant with --live).
# ---------------------------------------------------------------------------


async def _live_preflight(ink: Ink) -> bool:
    """Check DB reachability + seeded restaurants for --live. Return ok."""
    from sqlalchemy import text

    from app.core.config import settings
    from app.crud import restaurant as restaurant_crud
    from app.db.session import async_session_factory

    _substep(ink, "Live preflight — checking database + seed catalog …")
    _kv(ink, "DATABASE_URL", settings.database_url)
    _kv(ink, "LLM model", settings.llm_model)
    _kv(ink, "Embed model", settings.embedding_model)

    try:
        async with async_session_factory() as db:
            await db.execute(text("SELECT 1"))
            embedded = await restaurant_crud.count_with_embedding(db)
    except Exception as exc:  # noqa: BLE001 — surface a hint, don't traceback.
        print(f"    {ink.warn('✖ cannot reach the database:')} "
              f"{type(exc).__name__}: {exc}")
        _note(ink, "Ensure Postgres+pgvector is running and DATABASE_URL is set, "
                   "then retry --live.")
        _note(ink, "Or drop --live to run the fully offline mock (no DB needed).")
        return False

    if embedded == 0:
        print(f"    {ink.warn('✖ no embedded restaurants found.')}")
        _note(ink, "Seed first:  uv run python -m scripts.seed_restaurants")
        _note(ink, "Or drop --live to run the fully offline mock.")
        return False

    _kv(ink, "restaurants with embedding", str(embedded))
    return True


# ---------------------------------------------------------------------------
# Entry point.
# ---------------------------------------------------------------------------


async def _run(live: bool, no_color: bool, top_n: int) -> int:
    global _LIVE_MODE
    _LIVE_MODE = live
    ink = _make_ink(no_color)
    _print_intro(ink, live)

    if live:
        ok = await _live_preflight(ink)
        if not ok:
            return 0  # graceful — environment issue, not a code bug.

    # STEP 1-2: who's in the group + the session-level Q&A.
    _print_roster(ink)
    _print_session_qa(ink)

    # STEP 3: preference sub-agents (fan-out) → normalized MemberPrefs.
    prefs = await _print_preference_agents(ink)

    # Assemble the real PipelineState the orchestrator consumes.
    state = PipelineState(
        session_id=_DEMO_SESSION_ID,
        qa=_SESSION_QA,
        members=prefs,
        scheduled_for=_DEMO_SCHEDULED_FOR,
    )

    # STEP 4: reconcile the group (real _reconcile).
    reconciled = _print_reconcile(ink, state)
    state.reconciled = reconciled

    # STEP 5: retrieve + re-rank.
    try:
        ranked = await _print_orchestrate_and_rank(
            ink, state, reconciled, live=live, top_n=top_n
        )
    except Exception as exc:  # noqa: BLE001
        if live:
            print(f"    {ink.warn('✖ live pipeline call failed:')} "
                  f"{type(exc).__name__}: {exc}")
            _note(ink, "Likely a missing/rejected credential (OPENROUTER_API_KEY / "
                       "SALESFORCE_API_KEY) or")
            _note(ink, "a TLS issue (set NODE_EXTRA_CA_CERTS). Drop --live for the "
                       "offline mock.")
            return 0
        raise

    # STEP 6: final top-N.
    _print_top_picks(ink, ranked, top_n=top_n)
    _print_outro(ink, live)
    return 0


def main() -> None:
    """Parse args and run the narrated demo."""
    parser = argparse.ArgumentParser(
        description="Narrated mock-data walkthrough of the GrubGroup group "
                    "recommendation pipeline."
    )
    parser.add_argument(
        "--live",
        action="store_true",
        help="Run the real providers (OpenRouter embeddings + pgvector search + "
             "Salesforce/Claude re-rank) over the mock group. Needs a running DB "
             "+ API keys. Default is a fully offline deterministic mock.",
    )
    parser.add_argument(
        "--no-color",
        action="store_true",
        help="Disable ANSI colors (also auto-disabled when piped or NO_COLOR set).",
    )
    parser.add_argument(
        "--top",
        type=int,
        default=5,
        help="How many final picks to display (default: 5).",
    )
    args = parser.parse_args()
    raise SystemExit(asyncio.run(_run(args.live, args.no_color, max(1, args.top))))


if __name__ == "__main__":
    main()
