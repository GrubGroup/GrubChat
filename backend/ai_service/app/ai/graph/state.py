"""Typed LangGraph state for the preference -> reconcile -> re-rank pipeline."""

from __future__ import annotations

from datetime import datetime
from operator import add
from typing import Annotated, Any

from pydantic import BaseModel, Field


class MemberPref(BaseModel):
    """Normalized per-member preferences: durable Profile + session Qa overrides.

    The `*` fields (no prefix) are the durable Prisma `Profile` columns. The
    `qa_*` fields are this member's TEMPORARY, session-scoped overrides from
    their Qa row — they OUTRANK the Profile for this session only (e.g. profile
    likes japanese but qa says mexican -> mexican wins this session, japanese
    still counted). A `qa_*` value of None/[] means "the member didn't override
    it in QA", so the durable Profile value stands. (There is no noise_tolerance
    or allergies signal in the schema, so none is modeled here.)
    """

    user_id: int
    dietary_restrictions: list[str] = Field(default_factory=list)
    preferred_cuisines: list[str] = Field(default_factory=list)
    disliked_cuisines: list[str] = Field(default_factory=list)
    budget_min: int = 0
    budget_max: int = 0
    liked_restaurant_ids: list[int] = Field(default_factory=list)
    # Session-scoped Qa overrides (None/[] => fall back to the Profile value).
    qa_preferred_cuisines: list[str] = Field(default_factory=list)
    qa_disliked_cuisines: list[str] = Field(default_factory=list)
    qa_budget_min: int | None = None
    qa_budget_max: int | None = None
    # This member's PREFERRED location for the session (from their Qa row) — a
    # spot more convenient for them than the host's, used as a SECONDARY anchor in
    # the between-host-and-member ranking. None when they didn't set one (they're
    # fine with the host location) or a geocode miss left coords null.
    qa_location_lat: float | None = None
    qa_location_lon: float | None = None

    @property
    def effective_budget_cap(self) -> int | None:
        """This member's per-person price CEILING for the session, or None.

        Precedence: the QA cap they set this session, else their durable Profile
        cap. None means "this member imposes no ceiling" and comes from two
        cases that are deliberately treated identically:

          * They said "I'm flexible" on budget this session. That writes
            ``Qa.budget_max = NO_CAP`` (0), which is what DROPS their saved
            Profile budget for this session — the whole point of answering
            flexible. Because the QA value wins whenever it is non-NULL, a
            stored 0 shadows the Profile rather than falling through to it.
          * They have no budget data at all (a guest with no Profile row, whose
            MemberPref budget_max defaults to 0).

        Do NOT "fix" this to return 0 as a real cap: a $0 ceiling filters out
        every restaurant and empties the candidate list.

        ``budget_min`` is deliberately never surfaced here. A floor would mean
        "I only want expensive places", which is the exact behavior this models
        away from — see ``orchestrator_agent._member_budget_fit``.
        """
        cap = self.qa_budget_max if self.qa_budget_max is not None else self.budget_max
        return cap if cap and cap > 0 else None

    @property
    def location(self) -> tuple[float, float] | None:
        """This member's preferred (lat, lon), or None if they set no location."""
        if self.qa_location_lat is not None and self.qa_location_lon is not None:
            return (self.qa_location_lat, self.qa_location_lon)
        return None


class QaSignals(BaseModel):
    """Session-level (host-authored) Q&A signals; the shared event context.

    Per-member overrides (budget, cuisines) live on MemberPref, not here — this
    carries only the signals that are one-per-session: occasion (HOST-ONLY) and
    the resolved group search location (the host's primary anchor). The host's
    chosen event time is no longer here — it lives on Session.scheduled_for and
    is threaded into the pipeline separately for open/closed evaluation.
    """

    occasion: str | None = None
    location_mode: str | None = None
    location_lat: float | None = None
    location_lon: float | None = None
    radius_miles: float | None = None


class ReconciledConstraints(BaseModel):
    """Merged group constraints produced by the orchestrator's reconcile step."""

    required_dietary: list[str] = Field(default_factory=list)
    # Every constraining member's per-person price CEILING, ascending. A member
    # who said "I'm flexible" — or who has no budget data — contributes nothing,
    # so an empty list means budget does not shape the ranking at all. Budget is
    # SOFT: these caps drive a per-candidate `budget_fit` penalty, not a filter.
    member_budget_caps: list[int] = Field(default_factory=list)
    # RECALL GUARDRAIL for the pgvector prefilter — NOT a group promise, which is
    # why it is not named `price_max` and is excluded from the re-rank payload.
    # See orchestrator_agent._reconcile for why a ceiling still exists and why it
    # is keyed on the TIGHTEST cap with headroom.
    #
    # There is deliberately NO `avg_budget` here any more. A single "the group
    # spends around $N" scalar is by definition a TARGET, and under ceiling
    # semantics there is no target: the mean of the caps is >= the tightest cap
    # BY CONSTRUCTION, so telling the re-rank to aim for it always resolved to
    # "spend the most frugal member's entire ceiling" and let one high-budget
    # member drag the whole group upmarket. Do not reintroduce it in any form
    # (mean of caps, mean of midpoints, or a clamped variant).
    retrieval_price_ceiling: float | None = None
    # `center` is the retrieval anchor + PRIMARY location weight: the host's
    # location when set, else a member's (see orchestrator._reconcile). It also
    # seeds the bounding-box prefilter.
    center: tuple[float, float] | None = None
    radius_miles: float | None = None
    # The host's location (primary anchor) and every member's preferred location
    # (secondary anchors), threaded through for the between-host-and-member
    # proximity ranking. `host_location` may equal `center`; `member_locations`
    # excludes null coords. Empty/None => proximity ranking degrades to host-only.
    host_location: tuple[float, float] | None = None
    member_locations: list[tuple[float, float]] = Field(default_factory=list)
    # cuisine -> weight; preferred cuisines score positive, disliked negative.
    cuisine_weights: dict[str, float] = Field(default_factory=dict)


class CandidateRestaurant(BaseModel):
    """A retrieved restaurant payload passed to the LLM re-rank step."""

    id: int
    name: str
    cuisine_tags: list[str] = Field(default_factory=list)
    dietary_tags: list[str] = Field(default_factory=list)
    price_avg: float | None = None
    avg_rating: float | None = None
    # SOFT budget fit in [0, 1]: 1.0 when every constraining member can afford
    # this candidate, falling as the price runs past the TIGHTEST member's
    # ceiling. None when the candidate has no price or no member set a ceiling —
    # both mean "budget has nothing to say here", so the score is untouched.
    # Shown to the re-rank prompt and blended deterministically in _blend_score.
    budget_fit: float | None = None
    # Cosine distance from the reconciled query embedding (lower = closer).
    distance: float | None = None
    # Geo + hours, carried through so the orchestrator can score proximity to the
    # host/member anchors and evaluate open/closed at the event time. `long`
    # mirrors the Restaurant column name (not `lon`). `is_open` is computed
    # against Session.scheduled_for (None when no event time is known -> unknown
    # hours are treated as open, so it is not hard-filtered).
    lat: float | None = None
    long: float | None = None
    hours: str | None = None
    is_open: bool | None = None
    # Proximity tier for the between-host-and-member ranking (see orchestrator):
    # "between" (on the corridor between host + a member) > "host" (near host) >
    # "member" (near a member only) > "far"/None. Fed to the re-rank prompt.
    proximity_tier: str | None = None


class RankedItem(BaseModel):
    """A ranked pick shaped EXACTLY like the `RecommendationItem` table row."""

    restaurant_id: int
    match_score: float
    justification: str


class PipelineState(BaseModel):
    """LangGraph state threaded through the two-agent recommendation pipeline.

    `members` uses an additive reducer so the fan-out preference nodes (one
    `Send` per member) converge their single-element outputs into one list.
    `raw_profiles` is graph input only (the source rows the fan-out router maps
    over); it is not part of the persisted recommendation DTO.
    """

    session_id: int
    # Source Profile payloads the START router fans out over. Declared on the
    # state schema so LangGraph carries it into the router; consumed by the
    # preference nodes and never persisted.
    raw_profiles: list[dict[str, Any]] = Field(default_factory=list)
    members: Annotated[list[MemberPref], add] = Field(default_factory=list)
    qa: QaSignals = Field(default_factory=QaSignals)
    # The host's chosen event time (Session.scheduled_for), used to evaluate each
    # candidate's open/closed status. None when the host left it unset -> hours
    # are not hard-filtered (unknown time treated as always-open).
    scheduled_for: datetime | None = None
    reconciled: ReconciledConstraints | None = None
    candidates: list[CandidateRestaurant] = Field(default_factory=list)
    ranked: list[RankedItem] = Field(default_factory=list)
