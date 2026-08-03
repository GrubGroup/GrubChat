"""Conversational preference sub-agent: LLM parse + reconcile + agent reply.

This is the non-deterministic sibling of ``preference_agent.normalize_member``
(which stays deterministic, copying structured Profile columns). ``analyze_turn``
drives one turn of the per-member QA conversation: it reads the new message in
the context of prior turns + already-known signals, extracts/updates the
preference signal set (dietary / cuisines / budget / a member's optional
location), handles corrections against the prior signals, and produces a
natural-language reply that confirms what was captured and asks the next missing
question. It walks the same dietary -> likes -> dislikes -> budget -> location
flow as ``scripts/interactive_session.py``; the event's occasion and time are NOT
part of this conversation — the host sets them once in the pre-session modal
(``Session.scheduled_for`` + the host's seeded ``Qa.occasion``), so no chat turn,
host or member, ever asks for or extracts them.

It degrades gracefully: on any parse/transport failure it returns the prior
signals unchanged plus a safe reply, so a flaky LLM never turns a turn into a
500 (the endpoint layer still maps genuine transport errors to 502).
"""

from __future__ import annotations

import json
import re
from typing import Any

from app.ai.budget import NO_CAP, is_no_cap
from app.ai.llm.client import chat_completion, strip_json_fence
from app.ai.llm.prompts import build_preference_turn_messages
from app.core.config import settings
from app.ai.taxonomy import (
    compact_cuisine_terms,
    expand_cuisine_terms,
    expand_group_terms_only,
    normalize_dietary_terms,
    normalize_tag,
)
from app.schemas.ai import ConversationTurn, ExtractedSignals

# The signal names the reply logic asks about, in the order we prefer to ask:
# likes -> dislikes -> budget -> location. Dietary needs are NOT asked here —
# they're captured once in onboarding (durable Profile.dietary_restrictions) and
# feed the ranking hard-filter directly, so the session chat never re-asks them.
# The event-level fields are NOT asked here either — the host sets occasion AND
# the event TIME once, up front, in the pre-session modal (Qa.occasion via the
# host's seeded row; Session.scheduled_for). location is per-member and optional
# (each member may add a spot near them).
_MISSING_ORDER = [
    "preferred_cuisines",
    "disliked_cuisines",
    "budget",
    "location",
]

# occasion describes the EVENT and is set by the host in the pre-session modal
# (seeded onto the host's Qa row by the gateway), never in this chat. No one's
# sub-agent — host or member — asks about it, reports it missing, or extracts it
# (see _ask_order / _reconcile). is_host is retained only to frame the optional
# per-member location question relative to the host's chosen spot.

_VALID_LOCATION_MODES = {"named", "realtime", "unset"}

# Phrases that mean "I have no preference here — you decide". SUBJECT-NEUTRAL on
# purpose: "I'm flexible" is the canonical answer to BOTH the cuisine question and
# the budget question, so the phrase alone never tells you which one the member
# meant. Every caller must scope it: the cuisine path gates on an empty
# preferred_cuisines set, and _declares_no_budget_cap gates on budget being the
# question actually on the table (or the sentence naming money) — otherwise one
# "I'm flexible" at the cuisine step would silently erase the member's budget,
# and vice versa.
#
# Matched as space-padded substrings against a normalized message (apostrophes
# dropped, non-alphanumerics -> single spaces), so "I'm flexible" / "don't care"
# reduce to "im flexible" / "dont care". This is the deterministic backstop; the
# LLM's own `no_cuisine_preference` / `budget_flexible` flags (see the prompt)
# cover paraphrases the list misses.
_FLEXIBLE_PHRASES = frozenset(
    {
        "anything works",
        "anything is fine",
        "anything fine",
        "anything is good",
        "anything good",
        "anything is ok",
        "anything is okay",
        "anything goes",
        "eat anything",
        "open to anything",
        "open to whatever",
        "im flexible",
        "i am flexible",
        "flexible",
        "no preference",
        "no preferences",
        "no strong preference",
        "no strong feelings",
        "dont have a preference",
        "dont have any preference",
        "dont have preferences",
        "no opinion",
        "dont care",
        "doesnt matter",
        "does not matter",
        "no matter",
        "whatever",
        "whatever works",
        "you decide",
        "you choose",
        "you pick",
        "up to you",
        "your call",
        "surprise me",
        "im open",
        "i am open",
        "im not picky",
        "i am not picky",
        "not picky",
        "im easy",
        "i am easy",
    }
)


def _normalize_for_match(message: str) -> str:
    """Lowercase, drop apostrophes, and collapse non-alphanumerics to spaces.

    Space-padded so the phrase set can be tested as whole-token substrings
    ("flexible" matches " flexible " but not "inflexible").
    """
    out = []
    for ch in message.lower():
        out.append(ch if ch.isalnum() else " " if ch not in "'’" else "")
    return f" {' '.join(''.join(out).split())} "


def _expresses_flexibility(message: str) -> bool:
    """True when the message is a bare "no preference / you decide" statement.

    Subject-neutral — see _FLEXIBLE_PHRASES. Callers must decide WHICH question
    the flexibility applies to.
    """
    if not message:
        return False
    norm = _normalize_for_match(message)
    return any(f" {phrase} " in norm for phrase in _FLEXIBLE_PHRASES)


# Money vocabulary, used ONLY to classify what the AGENT just asked about (see
# _agent_asked_about_budget) — never to judge what the USER meant. That
# asymmetry is deliberate: the agent's questions are our own text, so matching
# them is safe, whereas "is this user sentence about money?" is direction-blind
# and cannot tell "money's no object" from "just keep it cheap". Single tokens,
# matched against the same normalized/space-padded form as _FLEXIBLE_PHRASES; a
# literal "$" is checked separately since normalization strips it.
_MONEY_TERMS = frozenset(
    {
        "budget",
        "price",
        "prices",
        "priced",
        "pricey",
        "cost",
        "costs",
        "expensive",
        "cheap",
        "money",
        "spend",
        "spending",
        "afford",
        "dollar",
        "dollars",
        "splurge",
        "bill",
        "tab",
    }
)


def _mentions_money(message: str) -> bool:
    """True when the text names price/money in any form (incl. a bare "$")."""
    if not message:
        return False
    if "$" in message:
        return True
    norm = _normalize_for_match(message)
    return any(f" {term} " in norm for term in _MONEY_TERMS)


# Phrases asking for something CHEAP. These are the OPPOSITE of "no ceiling", and
# they routinely ride along with a flexibility phrase ("doesn't matter, as long
# as it's cheap" / "I'm easy, just keep it cheap"), so they VETO the no-cap
# inference outright — otherwise the member's stated ceiling would be erased by a
# sentence that was tightening it.
_CHEAPNESS_PHRASES = frozenset(
    {
        "cheap",
        "cheaper",
        "cheapest",
        "inexpensive",
        "affordable",
        "budget friendly",
        "on a budget",
        "tight budget",
        "frugal",
        "economical",
        "not expensive",
        "nothing expensive",
        "not too expensive",
        "nothing too expensive",
        "nothing pricey",
        "not pricey",
        "keep it low",
        "keep costs down",
        "keep the cost down",
        "save money",
    }
)


def _prefers_cheap(message: str) -> bool:
    """True when the message asks for something CHEAP (never a no-ceiling answer)."""
    if not message:
        return False
    norm = _normalize_for_match(message)
    return any(f" {phrase} " in norm for phrase in _CHEAPNESS_PHRASES)


# Agent replies are shaped "confirm what I captured. next question?", and the
# confirm half routinely names the budget it just recorded ("Got it, ...; budget
# up to $20. Any spot that's more convenient for you?"). So only the TRAILING
# question tells us what was asked — matching the whole reply would read that
# confirmation as a budget question and mis-scope the next answer.
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")


def _agent_asked_about_budget(
    conversation_history: list[dict[str, Any]] | None,
) -> bool | None:
    """Was the agent's last question the budget one? None when it can't be told.

    Reads the last assistant turn and tests ONLY its final interrogative sentence
    for money vocabulary. This is the reliable signal for "which question is on
    the table", and it beats re-deriving it from the stored signals: the server's
    ask-order recompute (_compute_missing) counts an EMPTY cuisine list as still
    missing, while an intentional "nothing I avoid" answer legitimately leaves it
    empty — so for any member who answered that way, a recomputed pending
    question is stuck on cuisines for the rest of the conversation even though
    the agent has long since moved on to budget.
    """
    for turn in reversed(conversation_history or []):
        if turn.get("role") != "assistant":
            continue
        questions = [
            part
            for part in _SENTENCE_SPLIT.split(str(turn.get("content") or ""))
            if part.strip().endswith("?")
        ]
        return _mentions_money(questions[-1]) if questions else None
    return None


# Declarations that are unambiguously "no price ceiling" ON THEIR OWN — they name
# money AND flexibility in one phrase, so unlike _FLEXIBLE_PHRASES they need no
# further scoping and count whatever question the agent is on. Written in the
# NORMALIZED form _normalize_for_match produces: apostrophes are DROPPED, so
# "money's no object" must be spelled "moneys no object" here.
_BUDGET_FLEXIBLE_PHRASES = frozenset(
    {
        "no budget",
        "no budget limit",
        "no price limit",
        "no spending limit",
        "no limit on price",
        "money is no object",
        "moneys no object",
        "price is no object",
        "cost is no object",
        "price isnt a concern",
        "price is not a concern",
        "cost isnt a concern",
        "cost is not a concern",
        "price doesnt matter",
        "price does not matter",
        "cost doesnt matter",
        "cost does not matter",
        "money doesnt matter",
        "money does not matter",
        "whatever it costs",
        "spend whatever",
        "any price",
        "dont care about the price",
        "dont care what it costs",
        "dont care about cost",
        "not worried about price",
        "not worried about cost",
        "price is flexible",
        "budget is flexible",
        "budget isnt a concern",
        "budget is not a concern",
        "budget isnt an issue",
        "budget is not an issue",
        "budget doesnt matter",
        "budget does not matter",
        "dont have a budget",
        "do not have a budget",
        "no budget in mind",
        "flexible on budget",
        "flexible on price",
        "flexible on cost",
        "flexible with budget",
        "flexible with price",
        "no price cap",
        "no cap on price",
    }
)


def _expresses_budget_flexibility(message: str) -> bool:
    """True for a money-specific "no ceiling" declaration (self-corroborating)."""
    if not message:
        return False
    norm = _normalize_for_match(message)
    return any(f" {phrase} " in norm for phrase in _BUDGET_FLEXIBLE_PHRASES)


def _parsed_no_cuisine_pref(raw_signals: Any) -> bool:
    """Read the LLM's optional `no_cuisine_preference` flag from the parse."""
    return isinstance(raw_signals, dict) and bool(
        raw_signals.get("no_cuisine_preference")
    )


def _declares_no_budget_cap(
    raw_signals: Any, message: str, *, budget_pending: bool
) -> bool:
    """True when this turn declares NO price ceiling ("I'm flexible" on budget).

    Three rules, in order:

      1. A CHEAPNESS request vetoes everything. "Doesn't matter, as long as it's
         cheap" is a tighter ceiling, not the absence of one, and it matches the
         flexibility phrases; reading it as no-cap would invert what the member
         said.
      2. A money-specific declaration ("price isn't a concern", "money's no
         object") stands on its own — it names both flexibility and money, so it
         cannot be about anything else.
      3. A BARE flexibility signal — the LLM's `budget_flexible` flag, or a
         subject-neutral phrase like "I'm flexible" — counts only when BUDGET is
         the question on the table. Honoring one wrongly silently deletes a
         member's stated ceiling for the whole session, and nothing re-asks it
         afterwards (a no-cap budget counts as answered).

    Rule 3's gate is what stops a plain "I'm flexible" at the CUISINE step —
    which the prompt itself teaches the model to read as flexibility, and which
    _FLEXIBLE_PHRASES also matches — from zeroing the member's budget as a side
    effect of an answer about food.

    Note what is deliberately NOT a corroborator: "the message mentions money".
    That test cannot tell a loosening from a tightening ("just keep it cheap"
    mentions money too), and a false positive here is the expensive direction.
    """
    if _prefers_cheap(message):
        return False
    if _expresses_budget_flexibility(message):
        return True
    bare = _parsed_budget_flexible(raw_signals) or _expresses_flexibility(message)
    return bare and budget_pending


def _parsed_budget_flexible(raw_signals: Any) -> bool:
    """Read the LLM's optional `budget_flexible` flag from the parse.

    Strict `is True`: a stringly-typed "false" or a stray 1 must never zero
    someone's budget. The safe failure direction is ignoring a real flexible
    answer (the member can restate it), never erasing a stated ceiling.
    """
    return isinstance(raw_signals, dict) and raw_signals.get("budget_flexible") is True


def _ask_order(is_host: bool) -> list[str]:
    """The signals this member's agent asks about, in ask-order.

    Identical for host and member now that occasion/time are set in the
    pre-session modal rather than the chat — ``is_host`` is kept in the signature
    for symmetry with the rest of the turn plumbing (and future host-only asks).
    """
    return _MISSING_ORDER


class TurnResult:
    """Structured output of one conversational turn.

    Not a Pydantic model on purpose — the service maps this straight onto the
    AnalyzeResponse DTO. Carries the fully-reconciled signal set, the agent's
    natural-language reply, and which signals are still missing.
    """

    def __init__(
        self,
        *,
        signals: ExtractedSignals,
        agent_reply: str,
        missing_signals: list[str],
        degraded: bool = False,
        wants_profile_cuisines: bool = False,
    ) -> None:
        self.signals = signals
        self.agent_reply = agent_reply
        self.missing_signals = missing_signals
        # True when the LLM output was unusable and we fell back to prior signals.
        self.degraded = degraded
        # True when the member expressed NO cuisine preference ("anything works",
        # "I'm flexible") and none was captured, so the caller should acknowledge
        # their durable Profile favorites in the reply (see
        # apply_profile_cuisine_fallback — chat-layer only; the profile is already
        # the +1 ranking baseline, so nothing is persisted). Kept as a
        # request-for-data flag rather than doing the DB read here so analyze_turn
        # stays pure/no-I/O.
        self.wants_profile_cuisines = wants_profile_cuisines


def _clean_tags(value: Any) -> list[str] | None:
    """Coerce a value into a deduped list of lowercase single-concept tags, or None.

    Returns None when the model omitted the field (so we carry the prior value
    through); returns [] when the model explicitly cleared it. Normalizes via
    ``taxonomy.normalize_tag`` to the lowercase underscore LOOKUP form (e.g.
    "gluten free" / "Gluten-Free" -> "gluten_free"). For cuisines that is also
    the stored form; for DIETARY terms it is only the lookup key —
    ``_merge_dietary_field`` maps it onto the hyphenated tag the ``dietary_tags``
    column stores. Expansion of broad group / style terms happens later in
    ``_reconcile`` — this stays a pure normalizer.
    """
    if not isinstance(value, list):
        return None
    out: list[str] = []
    for item in value:
        tag = normalize_tag(item)
        if tag and tag not in out:
            out.append(tag)
    return out


def _clean_removals(value: Any) -> list[str]:
    """Normalize a removed_* list into plain tags (never None — defaults to []).

    These are the values the user explicitly told us to drop this turn. Unlike
    _clean_tags, an absent/garbage value yields [] (nothing to remove) rather
    than None, since "no removals" and "field omitted" mean the same thing here.
    """
    return _clean_tags(value) or []


def _merge_cuisine_field(
    prior: list[str],
    parsed_list: list[str] | None,
    removals: list[str],
) -> list[str]:
    """Merge one cuisine list: store COMPACT group/style keys, apply removals.

    Cuisine signals are stored **compact** — a broad answer is kept as its group
    key ("asian"), NOT the 20 member cuisines it covers. Expansion into concrete,
    retrieval-matchable tags happens later, at READ time, in
    ``orchestrator_agent._reconcile`` (``expand_cuisine_terms``), which is
    idempotent — so a legacy row that was stored expanded still yields the same
    weights. Keeping the stored form compact is a LATENCY fix: the analyze prompt
    asks the model to echo the FULL updated list each turn (the REPLACE contract
    that makes corrections work), and latency here is output-token-bound
    (~13 ms/token). Echoing 21 tags for "asian" every turn made each later
    question progressively slower; echoing just "asian" keeps every turn flat.

    Handles the four USER-INTENT shapes the prompt promises (answer / correct /
    add / remove) with one rule set:

      * ANSWER / ADD / CORRECT: when the model returns a list, it is the FULL
        intended set (the prompt asks for the complete corrected list), so it
        REPLACES the prior list — normalized only, NOT expanded. A correction
        drops the stale tag simply because the model left it out of the returned
        list. (A "like the group except one member" turn is expressed naturally
        as the group key in preferred + the member in disliked, which
        ``_reconcile`` at read time nets to zero for that member.)
      * REMOVE: the model also reports dropped values in a removed_* list. When
        it returned a replacement list, the removal is applied LITERALLY as a
        backstop (the model already excluded it; we just enforce it). When the
        model OMITTED the list (a pure "drop X" turn), we carry the prior list
        and expand the removal at the GROUP level only (expand_group_terms_only),
        so dropping a whole group ("no asian") also clears any legacy row that had
        been stored as expanded members, while dropping a STYLE ("no seafood")
        stays literal and never deletes a standalone tag that merely shares that
        style's alias (e.g. a separately-liked "sushi").
    """
    if parsed_list is not None:
        base = _dedupe_lower(parsed_list)  # compact: normalize, do NOT expand
        drop = set(_dedupe_lower(removals))  # literal backstop, no expansion
    else:
        base = list(prior)
        # Group-only expansion: whole cuisine groups cascade (so a whole-group
        # removal also clears any legacy expanded row); styles/specifics remove
        # only themselves (see expand_group_terms_only).
        drop = set(expand_group_terms_only(removals))

    return [tag for tag in base if tag not in drop]


def _merge_dietary_field(
    prior: list[str],
    parsed_list: list[str] | None,
    removals: list[str],
) -> list[str]:
    """Merge dietary_restrictions: map synonyms to controlled tags, apply removals.

    Dietary needs are never "grouped" the way cuisines are, so this uses the
    controlled-vocabulary synonym map (veggie -> vegetarian, no_gluten ->
    gluten-free) instead of cuisine expansion. Note the output is HYPHENATED for
    multi-word tags, matching the ``dietary_tags`` column — this is the one hard
    filter, so a separator mismatch here empties the result set entirely. Same
    replace-then-remove shape as the cuisine merge.
    """
    if parsed_list is not None:
        base = normalize_dietary_terms(parsed_list)
    else:
        base = list(prior)
    drop = set(normalize_dietary_terms(removals))
    return [tag for tag in base if tag not in drop]


def _dedupe_lower(tags: Any) -> list[str]:
    """Normalize a term list to canonical tags without any group/style expansion."""
    out: list[str] = []
    for item in tags or []:
        tag = normalize_tag(item)
        if tag and tag not in out:
            out.append(tag)
    return out


def _drop_conflicts(losing: list[str], added_expanded: set[str]) -> list[str]:
    """Remove cuisines from ``losing`` that conflict — after taxonomy expansion —
    with the set the user just added to the OPPOSITE side (the side they just
    spoke to wins).

    Because cuisines are now stored COMPACT (group keys, not their members), a
    conflict can hide inside a group key: disliking "asian" then liking "chinese"
    doesn't overlap literally, but does once "asian" expands to its members. When
    a compact entry partially conflicts, it is materialized to just its
    NON-conflicting members — the umbrella/group key itself is dropped so the
    orchestrator's read-time ``expand_cuisine_terms`` can't re-introduce the
    conflicting member. A non-conflicting entry stays compact (preserving the
    latency win). Without this, the orchestrator's +/-QA weights for the
    conflicting cuisine cancel to 0.0, silently neutralizing the fresh preference.

    This generalizes the old literal ``t not in added`` purge, which only worked
    back when signals were stored pre-expanded.
    """
    if not added_expanded:
        return losing
    result: list[str] = []
    for tag in losing:
        expanded = expand_cuisine_terms([tag])
        if added_expanded.isdisjoint(expanded):
            result.append(tag)  # no conflict — keep it compact
        else:
            # Partial/exact conflict: keep only the members that don't conflict,
            # dropping the group key (m == tag) so it isn't re-expanded at read.
            result.extend(
                m for m in expanded if m not in added_expanded and m != tag
            )
    return _dedupe_lower(result)


def _coerce_int(value: Any) -> int | None:
    """Best-effort parse of a whole-dollar budget value, or None."""
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _reconcile(
    prior: ExtractedSignals,
    parsed: dict[str, Any],
    *,
    message: str = "",
    budget_pending: bool = False,
) -> ExtractedSignals:
    """Merge the LLM's updated signals over the prior set, field by field.

    The prompt asks the model to return the FULL updated set (prior + this turn,
    with corrections applied), so a list it returns REPLACES the prior list —
    that is how a correction drops a stale tag. Fields the model omits are
    carried through from `prior`. Scalars are only overwritten when the model
    supplies a non-null value, so a partial turn never nulls out earlier answers.
    occasion is never read from the parse at all: it's a pre-session modal field
    (host's Qa row), not a conversational one, so no chat turn can set it.

    BUDGET is the exception to "scalars only change when the model supplies one":
    a flexibility declaration is an ANSWER that stores the NO_CAP sentinel, and
    it has to be able to overwrite a stored number. `message` / `budget_pending`
    are threaded in so that declaration can be corroborated — see
    _declares_no_budget_cap.

    Cuisine lists are additionally EXPANDED through the taxonomy (broad group
    terms like "asian" -> their member cuisines; style terms like "bbq" ->
    barbecue/bbq/grill) so the stored signals hold concrete, retrieval-matchable
    tags. The model's per-turn `removed_*` lists are applied as an explicit
    drop, which makes add/remove and mid-conversation corrections deterministic
    even against a large expanded list.
    """
    signals = prior.model_copy(deep=True)

    # Cuisine fields: expand group/style terms + honor explicit removals.
    signals.preferred_cuisines = _merge_cuisine_field(
        prior.preferred_cuisines,
        _clean_tags(parsed.get("preferred_cuisines")),
        _clean_removals(parsed.get("removed_preferred")),
    )
    signals.disliked_cuisines = _merge_cuisine_field(
        prior.disliked_cuisines,
        _clean_tags(parsed.get("disliked_cuisines")),
        _clean_removals(parsed.get("removed_disliked")),
    )
    # Resolve a like/dislike FLIP deterministically. If this turn newly ADDED a
    # cuisine to one side (e.g. "actually I like chinese" after a prior dislike),
    # drop it from the OTHER side — the list the user just spoke to wins. Keyed on
    # the newly-added set (not a blanket overlap purge) so an intentional
    # both-lists state from earlier turns is left alone. Without this, the model
    # omitting the opposite list leaves a tag in both, and the orchestrator's
    # +2/-2 QA weights cancel to 0.0, silently neutralizing the fresh preference.
    #
    # Conflicts are resolved in EXPANDED taxonomy space (via _drop_conflicts):
    # cuisines are stored compact now, so disliking a group ("asian") then liking
    # a member ("chinese") only collides once expanded — a literal set purge on
    # the compact tags would miss it and let the read-time weights cancel.
    added_pref = expand_cuisine_terms(
        set(signals.preferred_cuisines) - set(prior.preferred_cuisines)
    )
    added_dis = expand_cuisine_terms(
        set(signals.disliked_cuisines) - set(prior.disliked_cuisines)
    )
    if added_pref:
        signals.disliked_cuisines = _drop_conflicts(
            signals.disliked_cuisines, set(added_pref)
        )
    if added_dis:
        signals.preferred_cuisines = _drop_conflicts(
            signals.preferred_cuisines, set(added_dis)
        )

    # Storage-normalize to the COMPACT form: if the model expanded a group
    # ("asian" -> its 20 members) despite the prompt, collapse it back to the key
    # so the stored/echoed list stays small (the output-token latency fix). Done
    # AFTER flip resolution so each side's `blocked` opposite list is final — a
    # group whose members were split across like/dislike is left explicit rather
    # than snapping back to the umbrella and cancelling at read. Lossless: the key
    # re-expands to the full member set in orchestrator_agent._reconcile.
    signals.preferred_cuisines = compact_cuisine_terms(
        signals.preferred_cuisines, blocked=signals.disliked_cuisines
    )
    signals.disliked_cuisines = compact_cuisine_terms(
        signals.disliked_cuisines, blocked=signals.preferred_cuisines
    )
    # Dietary: controlled-vocabulary synonyms, no group expansion.
    signals.dietary_restrictions = _merge_dietary_field(
        prior.dietary_restrictions,
        _clean_tags(parsed.get("dietary_restrictions")),
        _clean_removals(parsed.get("removed_dietary")),
    )

    # Budget. "I'm flexible" stores the NO_CAP sentinel, which is what DROPS the
    # member's durable Profile budget for this session — a null/absent budget
    # would instead fall back to it (MemberPref.effective_budget_cap).
    #
    # A number the member names THIS turn always beats the declaration ("I'm
    # flexible, but let's stay under $30" -> a $30 ceiling). It is compared
    # against the PRIOR value because the prompt asks the model to echo unchanged
    # fields back verbatim, so a budget_max equal to what we already had is a
    # carry-through, not a fresh answer — without that check, "actually I'm
    # flexible" after a stored $20 would be silently defeated by the echo.
    # Only a new CEILING counts as "they named a number": budget_min is a floor,
    # which nothing in the ranking reads, so a model that renders "I'm flexible"
    # as a lone budget_min must not be able to veto the declaration.
    bmin = _coerce_int(parsed.get("budget_min"))
    bmax = _coerce_int(parsed.get("budget_max"))
    named_cap = bmax is not None and bmax != prior.budget_max
    if not named_cap and _declares_no_budget_cap(
        parsed, message, budget_pending=budget_pending
    ):
        signals.budget_min = NO_CAP
        signals.budget_max = NO_CAP
    else:
        if bmin is not None:
            signals.budget_min = bmin
        if bmax is not None:
            signals.budget_max = bmax
    # SINGLE SOURCE OF TRUTH: only the numbers persist (Qa has just budget_min /
    # budget_max), so the wire flag is always re-derived from them — here and in
    # session_service._merge_prior_qa — and can never desync from storage. None
    # (not False) while the budget question is unanswered, matching the field's
    # contract and the sibling derivation.
    signals.budget_flexible = (
        is_no_cap(signals.budget_max) if signals.budget_max is not None else None
    )

    # location_label is the only free-text field this conversation captures.
    # occasion is deliberately NOT read here — it's set once in the pre-session
    # modal (host's Qa row), never in a chat turn, so it is never overwritten by
    # a stray LLM extraction regardless of who is speaking.
    for field in ("location_label",):
        value = parsed.get(field)
        if isinstance(value, str) and value.strip():
            setattr(signals, field, value.strip())

    mode = parsed.get("location_mode")
    if isinstance(mode, str) and mode.strip().lower() in _VALID_LOCATION_MODES:
        signals.location_mode = mode.strip().lower()  # type: ignore[assignment]

    for field in ("location_lat", "location_lon", "radius_miles"):
        value = parsed.get(field)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            setattr(signals, field, float(value))

    return signals


def _compute_missing(signals: ExtractedSignals, *, is_host: bool) -> list[str]:
    """Local fallback for which core signals are still unknown, in ask-order.

    Used only when the LLM's own missing_signals list is absent/unusable. A
    budget counts as present if either bound is set; location once a mode is
    chosen. disliked_cuisines counts as present only once non-empty — the LLM's
    own missing_signals (the primary path) treats an intentional "nothing to
    avoid" as answered, so this deterministic fallback may re-ask dislikes once
    in the rare fully-degraded turn; that's an accepted degraded-path imperfect.
    dietary (captured once in onboarding) and occasion/time (pre-session modal
    fields) are never part of this conversation.
    """
    present: dict[str, bool] = {
        "preferred_cuisines": bool(signals.preferred_cuisines),
        "disliked_cuisines": bool(signals.disliked_cuisines),
        "budget": signals.budget_min is not None or signals.budget_max is not None,
        "location": signals.location_mode is not None,
    }
    return [name for name in _ask_order(is_host) if not present[name]]


def _clean_missing(value: Any, signals: ExtractedSignals, *, is_host: bool) -> list[str]:
    """Validate the model's missing_signals, falling back to the local compute."""
    order = _ask_order(is_host)
    if isinstance(value, list):
        allowed = set(order)
        out = [str(v).strip() for v in value if str(v).strip() in allowed]
        # Preserve our canonical ask-order.
        return [name for name in order if name in out]
    return _compute_missing(signals, is_host=is_host)


# One next-question per signal, in ask-order — mirrors the per-question prompts
# in scripts/interactive_session.py so the degraded (LLM-reply-unusable) path
# still walks the same likes -> dislikes -> budget -> location flow.
_QUESTION_FOR = {
    "preferred_cuisines": "What sounds good today — a cuisine, a vibe, or a kind of spot?",
    "disliked_cuisines": "Are there any cuisines you dislike or want to avoid?",
    "budget": "What is your comfortable price range per person?",
    "location": "Any spot that's more convenient for you? I can factor it in.",
}


def _summarize_tags(tags: list[str], *, limit: int = 4) -> str:
    """Human-readable join of a tag list, capped so an expanded group stays short.

    A broad "asian" answer expands to ~20 concrete tags; listing them all in the
    degraded reply would be unreadable, so we show the first few and count the
    rest ("thai, ramen, sushi, chinese, +16 more").
    """
    pretty = [t.replace("_", " ") for t in tags]
    if len(pretty) <= limit:
        return ", ".join(pretty)
    shown = ", ".join(pretty[:limit])
    return f"{shown}, +{len(pretty) - limit} more"


def _fallback_reply(
    signals: ExtractedSignals,
    missing: list[str],
    *,
    profile_cuisines: list[str] | None = None,
) -> str:
    """Deterministic reply used when the server authors the line itself.

    Confirms whatever is now captured and asks the next missing question — the
    same confirm-then-ask shape the prompt requests, so a degraded turn still
    behaves correctly for the user. `profile_cuisines`, when given, is the
    member's saved-Profile favorites to acknowledge after a "no preference" turn;
    it is phrased as "your usual" and takes the place of the extracted-preference
    bit. These are display-only and deliberately NOT in `signals`: the fallback is
    not persisted as a session override (see apply_profile_cuisine_fallback), so
    the ranking uses the Profile's own +1 weight rather than a heavier Qa +2.
    """
    bits: list[str] = []
    if signals.disliked_cuisines:
        bits.append(f"you don't like {_summarize_tags(signals.disliked_cuisines)}")
    if profile_cuisines:
        bits.append(f"I'll go with your usual {_summarize_tags(profile_cuisines)}")
    elif signals.preferred_cuisines:
        bits.append(f"you're into {_summarize_tags(signals.preferred_cuisines)}")
    if signals.dietary_restrictions:
        bits.append(f"dietary: {', '.join(signals.dietary_restrictions)}")
    # NO_CAP has to be read BEFORE the numeric branches or a flexible member is
    # told "budget up to $0" — the opposite of what they said.
    if is_no_cap(signals.budget_max):
        bits.append("budget is flexible")
    elif signals.budget_max is not None:
        bits.append(f"budget up to ${signals.budget_max}")
    elif signals.budget_min is not None:
        bits.append(f"budget from ${signals.budget_min}")

    confirm = f"Got it, {'; '.join(bits)}." if bits else "Got it."
    if missing:
        return f"{confirm} {_QUESTION_FOR.get(missing[0], 'What else matters to you?')}"
    return f"{confirm} That's everything I need — thanks!"


def apply_profile_cuisine_fallback(
    result: TurnResult, profile_cuisines: list[str]
) -> TurnResult:
    """Acknowledge a flexible member's saved cuisines WITHOUT boosting their weight.

    Called by the service ONLY when ``result.wants_profile_cuisines`` is set (the
    member said "anything works" / "I'm flexible" and named nothing) AND their
    Profile has saved favorites. This is what lets a member skip re-stating a
    cuisine every session.

    Deliberately CHAT-LAYER ONLY: it re-authors the reply to confirm we're falling
    back to their usual favorites and leaves the cuisine question answered
    (analyze_turn already dropped it from missing), but it does NOT write those
    cuisines into ``result.signals`` (and thus never into the session Qa row). The
    recommendation pipeline already counts every member's durable Profile cuisines
    at the base +1 weight, so the profile is used at ranking regardless; persisting
    them as a Qa override would stack the +2 session weight on top (=+3), letting a
    member who DECLINED to choose outrank one who actively did — the opposite of
    "flexible". Mutates and returns ``result``; a no-op if nothing nameable remains.
    """
    # Display-only, unexpanded (readable), and never a cuisine they just vetoed —
    # an explicit "no sushi, otherwise anything" must not be echoed back as a like.
    disliked = set(result.signals.disliked_cuisines)
    favorites = [c for c in _dedupe_lower(profile_cuisines) if c not in disliked]
    if not favorites:
        return result
    result.wants_profile_cuisines = False
    result.agent_reply = _fallback_reply(
        result.signals, result.missing_signals, profile_cuisines=favorites
    )
    return result


# Output-token cap for the analyze call. The turn's response is small — a
# delta-shaped signals JSON in fast mode, plus a one-line reply in full mode — so
# it never needs the model's full output ceiling. Beyond keeping latency low
# (output-token-bound, ~13 ms/token), this is LOAD-BEARING on OpenRouter: its
# credit precheck rejects a request with HTTP 402 unless the balance can afford
# the requested max_tokens, and an UNCAPPED call implicitly asks for the model's
# full ceiling (65535 for gemini-2.5-flash) — which a low-credit account can't
# cover, 402-ing every extraction turn before generation. `_FAST` covers the
# delta-only response; `_FULL` leaves headroom for the model-written reply.
_ANALYZE_MAX_TOKENS_FAST = 512
_ANALYZE_MAX_TOKENS_FULL = 1024


def _reasoning_off(provider: str) -> dict[str, Any] | None:
    """OpenRouter reasoning-disable knob for `provider`, else None.

    The analyze/extraction turn wants a direct JSON answer, not hidden reasoning.
    On a reasoning model (gemini-2.5-flash and claude-sonnet-5 both are, via
    OpenRouter) the model otherwise spends OUTPUT tokens — the latency-dominant
    resource here (~13 ms/token) — on a thinking phase before the JSON, and on a
    tight max_tokens budget can even exhaust it and return empty
    (finish_reason="length"), which forces a degraded turn. Turning reasoning off
    makes it emit the JSON directly: faster, and no spurious degradation. This is
    the same knob orchestrate() uses on its re-rank. Only OpenRouter understands
    it, so other providers (e.g. the Salesforce gateway, not a runaway-reasoning
    model) get None and are left untouched.
    """
    return (
        {"reasoning": {"enabled": False}}
        if provider.strip().lower() == "openrouter"
        else None
    )


async def analyze_turn(
    message: str,
    *,
    current_signals: ExtractedSignals | None = None,
    message_source: str = "text",
    conversation_history: list[ConversationTurn] | None = None,
    is_host: bool = False,
    host_location_label: str | None = None,
    low_latency: bool | None = None,
) -> TurnResult:
    """Parse one conversational turn into reconciled signals + an agent reply.

    Sends the new message plus prior signals/history to the LLM (no JSON mode —
    strict-JSON prompt + local fence strip), reconciles the parsed signals over
    the prior set (corrections replace lists; partial turns carry the rest
    through), and returns the updated ExtractedSignals, a confirm-then-ask reply,
    and the still-missing signals. The conversation walks the same
    dietary -> likes -> dislikes -> budget -> location flow as
    ``scripts/interactive_session.py`` for host and member alike; occasion and
    the event time are NOT asked here (they're set once in the pre-session
    modal). `is_host` is kept only to pass ``host_location_label`` framing to the
    prompt: for a non-host it's the host's chosen location, so the agent can
    frame the optional per-member location question relative to it ("the host set
    X — want somewhere closer to you?"). On any LLM/parse failure it degrades to
    the prior signals + a safe deterministic reply (TurnResult.degraded == True).

    LOW-LATENCY MODE (`low_latency`, defaulting to settings.analyze_low_latency)
    routes the call to the fast extraction provider/model and asks for a
    delta-shaped response with NO agent_reply, then composes the reply
    server-side from the reconciled signals + missing_signals. This is what makes
    the turn fit a real-time voice budget: latency here is output-token-bound
    (~13 ms/token measured), and it cuts ~3.8 s p50 to ~0.9 s at equal extraction
    quality. Because the reply is then always server-authored, an absent
    agent_reply is EXPECTED in this mode and must not be treated as degradation.
    """
    prior = current_signals or ExtractedSignals()
    history = [t.model_dump() for t in (conversation_history or [])]
    fast = settings.analyze_low_latency if low_latency is None else low_latency

    # Which question this message is answering — used to scope a bare "I'm
    # flexible" to the right signal (see _declares_no_budget_cap). Read from what
    # the agent ACTUALLY asked last turn; only when there is no history to read
    # (the opening turn, or a caller that doesn't replay it) do we fall back to
    # recomputing the ask-order, which can disagree with the agent (an
    # intentional "nothing I avoid" leaves an empty list that _compute_missing
    # still calls missing, pinning the recomputed question on cuisines forever).
    asked_budget = _agent_asked_about_budget(history)
    if asked_budget is None:
        pending = _compute_missing(prior, is_host=is_host)
        asked_budget = bool(pending) and pending[0] == "budget"
    budget_pending = asked_budget

    messages = build_preference_turn_messages(
        message,
        message_source=message_source,
        conversation_history=history,
        current_signals=prior.model_dump(),
        is_host=is_host,
        host_location_label=host_location_label,
        low_latency=fast,
    )

    # NOTE: do NOT pass response_format={"type": "json_object"} — the active
    # Salesforce/Claude gateway ignores it and returns an empty "{}". The prompt
    # demands strict JSON and we strip fences below (same pattern as the re-rank).
    # In low-latency mode the provider/model pair is overridden together: a model
    # name is only valid for its own provider, and the measured speedup came from
    # the pair (the same model was ~3x slower through the other gateway).
    if fast:
        provider = settings.active_extraction_provider
        raw = await chat_completion(
            messages,
            temperature=0.2,
            provider=provider,
            model=settings.active_extraction_model,
            max_tokens=_ANALYZE_MAX_TOKENS_FAST,
            extra_body=_reasoning_off(provider),
        ) or ""
    else:
        raw = await chat_completion(
            messages,
            temperature=0.2,
            max_tokens=_ANALYZE_MAX_TOKENS_FULL,
            extra_body=_reasoning_off(settings.llm_provider),
        ) or ""

    try:
        parsed = json.loads(strip_json_fence(raw))
    except (ValueError, TypeError):
        parsed = None

    if not isinstance(parsed, dict):
        signals = prior
        missing = _compute_missing(prior, is_host=is_host)
        # Even on a degraded (LLM-unusable) turn, honor a "no cuisine preference"
        # message so a flaky LLM doesn't strand the member in the ask loop: drop
        # the cuisine question and flag the Profile-favorites acknowledgment
        # (message-only, since there is no parse to read a flag from).
        wants_profile_cuisines = (
            _expresses_flexibility(message) and not prior.preferred_cuisines
        )
        if wants_profile_cuisines:
            missing = [m for m in missing if m != "preferred_cuisines"]
        # Same for a budget flexibility declaration. This one WRITES (NO_CAP onto
        # a copy of the prior signals) rather than just dropping the question:
        # marking budget answered without storing the sentinel would leave the
        # member's Profile cap silently in force — the exact bug being fixed. Safe
        # on a degraded turn because the detection is fully deterministic (phrase
        # list + the corroboration gate), with no parse involved.
        if _declares_no_budget_cap({}, message, budget_pending=budget_pending):
            signals = prior.model_copy(deep=True)
            signals.budget_min = NO_CAP
            signals.budget_max = NO_CAP
            signals.budget_flexible = True
            missing = [m for m in missing if m != "budget"]
        return TurnResult(
            signals=signals,
            agent_reply=_fallback_reply(signals, missing),
            missing_signals=missing,
            degraded=True,
            wants_profile_cuisines=wants_profile_cuisines,
        )

    raw_signals = parsed.get("extracted_signals")
    if not isinstance(raw_signals, dict):
        # Tolerate a model that put the signal fields at the top level.
        raw_signals = parsed

    signals = _reconcile(
        prior, raw_signals, message=message, budget_pending=budget_pending
    )
    missing = _clean_missing(parsed.get("missing_signals"), signals, is_host=is_host)

    # "Anything works" handling: when the member expressed no cuisine preference
    # (a flexibility phrase in the message, or the LLM's no_cuisine_preference
    # flag) and none was captured this turn, treat the cuisine question as
    # ANSWERED — dropping it from missing stops the re-ask loop — and flag that the
    # caller should acknowledge the member's saved-Profile favorites in the reply
    # (used at ranking as the +1 baseline; not persisted as a session override).
    wants_profile_cuisines = (
        _expresses_flexibility(message) or _parsed_no_cuisine_pref(raw_signals)
    ) and not signals.preferred_cuisines
    if wants_profile_cuisines:
        missing = [m for m in missing if m != "preferred_cuisines"]

    # A no-cap budget IS an answer. _clean_missing returns the MODEL's list
    # verbatim whenever it's a list, and the model — having been told to leave
    # budget_min/budget_max null when flexible — routinely still reports "budget"
    # as missing. Without this backstop the agent confirms "budget is flexible"
    # and then re-asks the price range in the same breath, every turn, and never
    # reaches the "that's everything I need" wrap-up. Mirrors the cuisine
    # backstop above; _compute_missing (the fallback path) already agrees, since
    # NO_CAP is `0 is not None`.
    if is_no_cap(signals.budget_max):
        missing = [m for m in missing if m != "budget"]

    if fast or wants_profile_cuisines:
        # Low-latency mode asked the model NOT to write a reply, so the server
        # authors the whole line. _fallback_reply already produces exactly the
        # confirm-then-ask shape the prompt otherwise requests, and it walks the
        # canonical ask-order — which also makes the spoken wording deterministic
        # (what the voice/TTS path needs) rather than a model paraphrase. We also
        # author it when wants_profile_cuisines is set, so the LLM's reply (written
        # before the Profile back-fill, and likely still re-asking cuisine) can't
        # leak through ahead of apply_profile_cuisine_fallback.
        reply = _fallback_reply(signals, missing)
    else:
        reply = parsed.get("agent_reply")
        if not (isinstance(reply, str) and reply.strip()):
            reply = _fallback_reply(signals, missing)
        else:
            reply = reply.strip()

    return TurnResult(
        signals=signals,
        agent_reply=reply,
        missing_signals=missing,
        wants_profile_cuisines=wants_profile_cuisines,
    )
