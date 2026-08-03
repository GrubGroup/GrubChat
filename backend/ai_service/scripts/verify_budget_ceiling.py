"""Offline checks for ceiling-only budget semantics and the "I'm flexible" answer.

Covers the two halves of the budget fix:

  1. A budget is a CEILING. A candidate at or under a member's ceiling costs that
     member nothing, and a member whose ceiling is above the group's tightest one
     has ZERO influence on the ranking — that is the invariant that stops a
     high-budget diner from pulling everyone else's picks upmarket.
  2. "I'm flexible" on budget stores the NO_CAP sentinel, which DROPS that
     member's durable Profile budget for the session, counts as answering the
     budget question, and never leaks into the durable Profile.

Needs no database and no LLM key: every function under test is pure, and the one
LLM call in ``analyze_turn`` is monkeypatched. ``app.db.session`` builds an engine
at import but SQLAlchemy does not connect eagerly.

    cd backend/ai_service && uv run python -m scripts.verify_budget_ceiling
"""

from __future__ import annotations

import asyncio
import json
import sys
from itertools import combinations

import app.ai.agents.conversation_agent as conversation_agent
from app.ai.agents.conversation_agent import (
    _compute_missing,
    _fallback_reply,
    _reconcile as reconcile_turn,
    analyze_turn,
)
from app.ai.agents.orchestrator_agent import (
    _blend_score,
    _group_budget_fit,
    _member_budget_fit,
    _reconcile as reconcile_group,
)
from app.ai.budget import NO_CAP, is_no_cap
from app.ai.geo import TIER_BONUS
from app.ai.graph.state import MemberPref, PipelineState
from app.models.qa import Qa
from app.schemas.ai import ConversationTurn, ExtractedSignals
from app.services.profile_service import profile_diff, qa_diff
from app.services.session_service import _merge_prior_qa

_passed = 0
_failed = 0


def check(label: str, ok: bool, detail: str = "") -> None:
    """Record one assertion; prints PASS/FAIL and keeps going."""
    global _passed, _failed
    if ok:
        _passed += 1
        print(f"  PASS  {label}")
    else:
        _failed += 1
        print(f"  FAIL  {label}{('  -> ' + detail) if detail else ''}")


def _member(uid: int, *, profile_cap: int = 0, qa_cap: int | None = None) -> MemberPref:
    return MemberPref(user_id=uid, budget_max=profile_cap, qa_budget_max=qa_cap)


def _caps(*members: MemberPref) -> list[int]:
    return reconcile_group(
        PipelineState(session_id=1, members=list(members))
    ).member_budget_caps


# --- 1. Ceiling semantics -----------------------------------------------------


def check_ceiling_semantics() -> None:
    print("\n[1] A budget is a ceiling — cheaper is never penalized")

    check(
        "at the cap fits perfectly",
        _member_budget_fit(20, 20) == 1.0,
    )
    check(
        "well under the cap fits just as perfectly (no 'too cheap' penalty)",
        _member_budget_fit(5, 20) == 1.0 == _member_budget_fit(19, 20),
    )
    check(
        "over the cap decays",
        _member_budget_fit(25, 20) < 1.0 and _member_budget_fit(60, 20) < _member_budget_fit(25, 20),
    )
    check(
        "decay never clips to 0, so pricey venues stay ORDERED",
        _member_budget_fit(200, 20) > 0.0
        and _member_budget_fit(120, 20) > _member_budget_fit(200, 20),
    )
    check(
        "overage is RELATIVE: $5 over $15 hurts more than $5 over $90",
        _member_budget_fit(20, 15) < _member_budget_fit(95, 90),
    )


# --- 2. A high ceiling has zero influence -------------------------------------


def check_high_cap_is_inert() -> None:
    print("\n[2] A member above the tightest ceiling cannot move the ranking")

    prices = [5, 10, 12, 15, 20, 25, 30, 45, 60, 90, 120, 200]
    frugal = [20]
    with_rich = [20, 200]
    mismatched = [15, 25, 40, 200]
    tightest_only = [15]

    check(
        "adding a $200 diner changes NO score for a $20 diner's group",
        all(
            _group_budget_fit(p, frugal) == _group_budget_fit(p, with_rich)
            for p in prices
        ),
        detail=str(
            [(p, _group_budget_fit(p, frugal), _group_budget_fit(p, with_rich)) for p in prices]
        ),
    )
    check(
        "a mixed group scores exactly as its tightest member alone",
        all(
            _group_budget_fit(p, mismatched) == _group_budget_fit(p, tightest_only)
            for p in prices
        ),
    )

    # Exhaustive monotonicity: the group fit must never RISE with price, for any
    # combination of ceilings. This is what makes "cheaper is never worse"
    # provable rather than tuned.
    universe = [12, 15, 20, 25, 40, 60, 200]
    violations = []
    for size in (1, 2, 3, 4):
        for caps in combinations(universe, size):
            fits = [_group_budget_fit(p, list(caps)) for p in prices]
            for lo, hi in zip(fits, fits[1:]):
                if hi > lo:
                    violations.append((caps, lo, hi))
    check(
        "group fit is non-increasing in price for every ceiling combination",
        not violations,
        detail=str(violations[:3]),
    )

    check(
        "budget_fit is 1.0 (zero penalty) at and below the tightest ceiling",
        all(_group_budget_fit(p, mismatched) == 1.0 for p in (5, 10, 15)),
    )


# --- 3. The penalty is calibrated against the location bonus ------------------


def check_penalty_calibration() -> None:
    print("\n[3] Budget outweighs the best location bonus once clearly over budget")

    best_bonus = max(TIER_BONUS.values())
    caps = [20]
    # 25% over the ceiling is the documented crossover point.
    at_knee = _blend_score(0.80, "between", _group_budget_fit(25, caps))
    affordable_far = _blend_score(0.80, None, _group_budget_fit(20, caps))
    way_over = _blend_score(0.80, "between", _group_budget_fit(60, caps))

    check(
        "the best-located candidate 25% over budget only TIES an affordable one",
        abs(at_knee - affordable_far) < 1e-9,
        detail=f"between@$25={at_knee} vs far@$20={affordable_far}",
    )
    check(
        "well over budget loses even on the perfect corridor",
        way_over < affordable_far,
        detail=f"between@$60={way_over} vs far@$20={affordable_far}",
    )
    check(
        "budget is never a BONUS — an affordable candidate is never boosted",
        _blend_score(0.50, None, 1.0) == 0.50,
    )
    check(
        "no ceiling anywhere in the group leaves scores untouched",
        _blend_score(0.50, None, None) == 0.50 and best_bonus > 0,
    )


# --- 4. NO_CAP drops the Profile budget ---------------------------------------


def check_no_cap_drops_profile() -> None:
    print("\n[4] 'I'm flexible' drops that member's durable Profile budget")

    rich = _member(1, profile_cap=200)
    check("a $200 Profile normally contributes its ceiling", _caps(rich) == [200])

    flexible = _member(1, profile_cap=200, qa_cap=NO_CAP)
    check(
        "the same member who said 'I'm flexible' contributes NOTHING",
        _caps(flexible) == [],
        detail=str(_caps(flexible)),
    )
    check(
        "the reported bug: a $20 diner is unaffected by a flexible $200 diner",
        _caps(_member(1, profile_cap=20), flexible) == [20],
    )
    check(
        "a guest with no budget data at all also contributes nothing",
        _caps(_member(9)) == [],
    )
    check(
        "an all-flexible group has no ceilings and no retrieval filter",
        reconcile_group(
            PipelineState(session_id=1, members=[flexible, _member(2, qa_cap=NO_CAP)])
        ).retrieval_price_ceiling
        is None,
    )
    check(
        "a NULL Qa budget still falls back to the Profile (not answered yet)",
        _caps(_member(1, profile_cap=200, qa_cap=None)) == [200],
    )
    check(
        "the retrieval ceiling is keyed on the TIGHTEST cap, with headroom",
        reconcile_group(
            PipelineState(
                session_id=1,
                members=[_member(1, profile_cap=20), _member(2, profile_cap=200)],
            )
        ).retrieval_price_ceiling
        == 30.0,
    )


# --- 5. The chat turn ---------------------------------------------------------


def check_turn_reconcile() -> None:
    print("\n[5] The chat turn stores, scopes and reports a flexible budget")

    answered = ExtractedSignals(preferred_cuisines=["thai"], disliked_cuisines=["sushi"])

    flex = reconcile_turn(answered, {}, message="I'm flexible", budget_pending=True)
    check(
        "'I'm flexible' at the budget step stores NO_CAP",
        flex.budget_max == NO_CAP and flex.budget_flexible is True,
        detail=f"{flex.budget_min}/{flex.budget_max}",
    )
    check(
        "a NO_CAP budget counts as ANSWERED (no re-ask loop)",
        "budget" not in _compute_missing(flex, is_host=True),
    )
    check(
        "the reply says 'flexible', not 'up to $0'",
        "budget is flexible" in _fallback_reply(flex, []),
        detail=_fallback_reply(flex, []),
    )

    stated = ExtractedSignals(budget_min=15, budget_max=20)
    flip = reconcile_turn(
        stated,
        {"budget_min": 15, "budget_max": 20, "budget_flexible": True},
        message="actually I'm flexible on budget",
        budget_pending=False,
    )
    check(
        "a later 'actually I'm flexible' beats the model echoing the old number",
        flip.budget_max == NO_CAP,
        detail=str(flip.budget_max),
    )

    same_turn = reconcile_turn(
        stated,
        {"budget_max": 30, "budget_flexible": True},
        message="I'm flexible, but let's stay under $30",
        budget_pending=True,
    )
    check(
        "a number named in the SAME turn wins over the flexible flag",
        same_turn.budget_max == 30 and same_turn.budget_flexible is False,
        detail=str(same_turn.budget_max),
    )

    unflex = reconcile_turn(
        ExtractedSignals(budget_min=NO_CAP, budget_max=NO_CAP),
        {"budget_max": 25},
        message="let's say 25",
        budget_pending=False,
    )
    check(
        "naming a number later un-flexes the member",
        unflex.budget_max == 25 and unflex.budget_flexible is False,
    )

    print("\n[5b] Cross-question flexibility must NOT erase a budget")

    cuisine_step = reconcile_turn(
        ExtractedSignals(),
        {"no_cuisine_preference": True},
        message="I'm flexible",
        budget_pending=False,
    )
    check(
        "'I'm flexible' at the CUISINE step leaves budget untouched",
        cuisine_step.budget_max is None,
        detail=str(cuisine_step.budget_max),
    )

    location_step = reconcile_turn(
        ExtractedSignals(budget_max=20),
        {"budget_max": 20, "budget_flexible": True},
        message="I'm easy, whatever's convenient",
        budget_pending=False,
    )
    check(
        "a spurious flag at the LOCATION step cannot delete a stated $20 ceiling",
        location_step.budget_max == 20,
        detail=str(location_step.budget_max),
    )

    stray = reconcile_turn(
        ExtractedSignals(budget_max=20),
        {"budget_flexible": 1},
        message="ok",
        budget_pending=True,
    )
    check(
        "a truthy-but-not-True flag is ignored (strict `is True`)",
        stray.budget_max == 20,
    )

    money = reconcile_turn(
        ExtractedSignals(budget_max=20),
        {"budget_max": 20},
        message="honestly price isn't a concern for me",
        budget_pending=False,
    )
    check(
        "an explicit MONEY flexibility phrase fires on any question",
        money.budget_max == NO_CAP,
        detail=str(money.budget_max),
    )

    print("\n[5c] A CHEAPNESS request is the opposite of 'no ceiling'")

    for message in (
        "doesn't matter, as long as it's cheap",
        "I'm easy, just keep it cheap",
        "whatever works, nothing too expensive",
        "I'm flexible, but let's keep costs down",
    ):
        cheap = reconcile_turn(
            ExtractedSignals(budget_min=15, budget_max=25),
            {"budget_min": 15, "budget_max": 25, "budget_flexible": True},
            message=message,
            budget_pending=True,
        )
        check(
            f"{message!r} does NOT erase the stored ceiling",
            cheap.budget_max == 25,
            detail=str(cheap.budget_max),
        )

    print("\n[5d] A lone budget_min cannot veto a flexible answer")

    floor_only = reconcile_turn(
        ExtractedSignals(preferred_cuisines=["thai"]),
        {"budget_min": 0, "budget_flexible": True},
        message="I'm flexible",
        budget_pending=True,
    )
    check(
        "a model that emits only budget_min still yields NO_CAP",
        floor_only.budget_max == NO_CAP,
        detail=str(floor_only.budget_max),
    )
    check(
        "an unanswered budget derives budget_flexible as None, not False",
        reconcile_turn(
            ExtractedSignals(), {"preferred_cuisines": ["thai"]}, message="thai please"
        ).budget_flexible
        is None,
    )


# --- 6. Persistence -----------------------------------------------------------


def check_persistence() -> None:
    print("\n[6] NO_CAP persists to Qa, never to the durable Profile")

    flexible = ExtractedSignals(budget_min=NO_CAP, budget_max=NO_CAP, budget_flexible=True)
    check(
        "qa_diff writes the sentinel (0 survives the `is not None` filter)",
        qa_diff(flexible).get("budget_max") == NO_CAP,
        detail=str(qa_diff(flexible)),
    )
    check(
        "profile_diff drops BOTH bounds — a session answer is not a saved one",
        "budget_max" not in profile_diff(flexible)
        and "budget_min" not in profile_diff(flexible),
        detail=str(profile_diff(flexible)),
    )
    check(
        "a real budget still reaches the Profile on a profile-edit turn",
        profile_diff(ExtractedSignals(budget_min=15, budget_max=25))["budget_max"] == 25,
    )
    # A degraded turn can leave the derived flag null; the guard must key on the
    # stored number, not the flag.
    check(
        "profile_diff guards on the NUMBER, so a null flag still blocks the write",
        "budget_max" not in profile_diff(ExtractedSignals(budget_min=0, budget_max=0)),
    )

    stored = Qa(session_id=1, user_id=1, budget_min=NO_CAP, budget_max=NO_CAP)
    merged = _merge_prior_qa(ExtractedSignals(), stored)
    check(
        "a stored NO_CAP rehydrates on the NEXT turn (not read as unanswered)",
        merged.budget_max == NO_CAP and merged.budget_flexible is True,
    )
    unanswered = _merge_prior_qa(ExtractedSignals(), Qa(session_id=1, user_id=1))
    check(
        "an unanswered budget rehydrates as null, not as flexible",
        unanswered.budget_max is None and unanswered.budget_flexible is None,
    )
    check("is_no_cap(None) is False — null means 'not answered'", not is_no_cap(None))


# --- 7. Full turn, including the degraded path --------------------------------


def check_analyze_turn() -> None:
    print("\n[7] analyze_turn end to end (LLM stubbed)")

    prior = ExtractedSignals(preferred_cuisines=["thai"], disliked_cuisines=["sushi"])

    def stub(payload: str):
        async def _call(*_args, **_kwargs):
            return payload

        return _call

    original = conversation_agent.chat_completion
    try:
        # The model does the right thing but STILL reports budget missing — the
        # common case, and the one the deterministic backstop exists for.
        conversation_agent.chat_completion = stub(
            json.dumps(
                {
                    "extracted_signals": {"budget_flexible": True},
                    "missing_signals": ["budget", "location"],
                }
            )
        )
        result = asyncio.run(
            analyze_turn("I'm flexible", current_signals=prior, low_latency=True)
        )
        check(
            "a flexible turn stores NO_CAP",
            result.signals.budget_max == NO_CAP,
        )
        check(
            "'budget' is stripped from the model's missing list",
            "budget" not in result.missing_signals,
            detail=str(result.missing_signals),
        )
        check(
            "the agent does not confirm flexibility and re-ask price in one breath",
            "price range" not in result.agent_reply,
            detail=result.agent_reply,
        )

        # Degraded: unparseable LLM output. The deterministic phrase path must
        # still store the sentinel, or the member's Profile cap silently applies.
        conversation_agent.chat_completion = stub("not json at all")
        degraded = asyncio.run(
            analyze_turn("I'm flexible", current_signals=prior, low_latency=True)
        )
        check(
            "a degraded turn still honors a flexible budget answer",
            degraded.degraded and degraded.signals.budget_max == NO_CAP,
            detail=f"degraded={degraded.degraded} max={degraded.signals.budget_max}",
        )
        degraded_cuisine = asyncio.run(
            analyze_turn(
                "I'm flexible", current_signals=ExtractedSignals(), low_latency=True
            )
        )
        check(
            "a degraded turn at the CUISINE step leaves budget untouched",
            degraded_cuisine.signals.budget_max is None,
        )

        # The question the agent ASKED is read from the transcript, not
        # recomputed: a member who answered dislikes with "nothing" leaves that
        # list empty forever, so a recompute would stay stuck on cuisines and
        # reject the canonical "I'm flexible" answer to the budget question.
        conversation_agent.chat_completion = stub(
            json.dumps(
                {
                    "extracted_signals": {"budget_flexible": True},
                    "missing_signals": ["budget", "location"],
                }
            )
        )
        no_dislikes = ExtractedSignals(preferred_cuisines=["thai"], disliked_cuisines=[])
        history = [
            ConversationTurn(role="user", content="thai"),
            ConversationTurn(
                role="assistant",
                content="Got it, you're into thai. Are there any cuisines you dislike or want to avoid?",
            ),
            ConversationTurn(role="user", content="nothing I avoid"),
            ConversationTurn(
                role="assistant",
                content="Got it, you're into thai. What is your comfortable price range per person?",
            ),
        ]
        after_no_dislikes = asyncio.run(
            analyze_turn(
                "I'm flexible",
                current_signals=no_dislikes,
                conversation_history=history,
                low_latency=True,
            )
        )
        check(
            "'nothing I avoid' does not block a later flexible budget answer",
            after_no_dislikes.signals.budget_max == NO_CAP,
            detail=str(after_no_dislikes.signals.budget_max),
        )
        check(
            "and budget stops being asked",
            "budget" not in after_no_dislikes.missing_signals,
            detail=str(after_no_dislikes.missing_signals),
        )

        # The confirm half of an agent reply names the budget it just recorded;
        # only the trailing question says what is being asked.
        location_history = [
            ConversationTurn(
                role="assistant",
                content=(
                    "Got it, you're into thai; budget up to $20. "
                    "Any spot that's more convenient for you? I can factor it in."
                ),
            ),
        ]
        conversation_agent.chat_completion = stub(
            json.dumps(
                {
                    "extracted_signals": {"budget_max": 20, "budget_flexible": True},
                    "missing_signals": [],
                }
            )
        )
        at_location = asyncio.run(
            analyze_turn(
                "I'm easy, whatever's convenient",
                current_signals=ExtractedSignals(
                    preferred_cuisines=["thai"], budget_max=20
                ),
                conversation_history=location_history,
                low_latency=True,
            )
        )
        check(
            "a budget CONFIRMATION in the reply is not mistaken for a budget QUESTION",
            at_location.signals.budget_max == 20,
            detail=str(at_location.signals.budget_max),
        )
    finally:
        conversation_agent.chat_completion = original


def main() -> int:
    print("Verifying ceiling-only budget semantics (no DB, no LLM key required)")
    check_ceiling_semantics()
    check_high_cap_is_inert()
    check_penalty_calibration()
    check_no_cap_drops_profile()
    check_turn_reconcile()
    check_persistence()
    check_analyze_turn()
    print(f"\n{_passed} passed, {_failed} failed")
    return 1 if _failed else 0


if __name__ == "__main__":
    sys.exit(main())
