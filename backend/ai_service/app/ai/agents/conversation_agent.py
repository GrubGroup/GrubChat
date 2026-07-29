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
from typing import Any

from app.ai.llm.client import chat_completion, strip_json_fence
from app.ai.llm.prompts import build_preference_turn_messages
from app.core.config import settings
from app.ai.taxonomy import (
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
    ) -> None:
        self.signals = signals
        self.agent_reply = agent_reply
        self.missing_signals = missing_signals
        # True when the LLM output was unusable and we fell back to prior signals.
        self.degraded = degraded


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
    """Merge one cuisine list: expand group/style terms, then apply removals.

    Handles the four USER-INTENT shapes the prompt promises (answer / correct /
    add / remove) with one rule set:

      * ANSWER / ADD / CORRECT: when the model returns a list, it is the FULL
        intended set (the prompt asks for the complete corrected list), so it
        REPLACES the prior list. We expand broad terms ("asian" -> its member
        cuisines, "bbq" -> barbecue/bbq/grill) so the stored tags actually match
        restaurants. A correction therefore drops the stale tag simply because
        the model left it out of the returned list.
      * REMOVE: the model also reports dropped values in a removed_* list. When
        it returned a replacement list, the removal is applied LITERALLY as a
        backstop (the model already excluded it; we just enforce it) — this is
        safe even when a kept cuisine overlaps a removed group. When the model
        OMITTED the list (a pure "drop X" turn), we carry the prior list and
        expand the removal at the GROUP level only (expand_group_terms_only), so
        dropping a whole group ("no asian") removes every member, while dropping
        a STYLE ("no seafood") stays literal and never deletes a standalone tag
        that merely shares that style's alias (e.g. a separately-liked "sushi").
    """
    if parsed_list is not None:
        base = expand_cuisine_terms(parsed_list)
        drop = set(_dedupe_lower(removals))  # literal backstop, no expansion
    else:
        base = list(prior)
        # Group-only expansion: whole cuisine groups cascade; styles/specifics
        # remove only themselves (see expand_group_terms_only).
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


def _coerce_int(value: Any) -> int | None:
    """Best-effort parse of a whole-dollar budget value, or None."""
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _reconcile(prior: ExtractedSignals, parsed: dict[str, Any]) -> ExtractedSignals:
    """Merge the LLM's updated signals over the prior set, field by field.

    The prompt asks the model to return the FULL updated set (prior + this turn,
    with corrections applied), so a list it returns REPLACES the prior list —
    that is how a correction drops a stale tag. Fields the model omits are
    carried through from `prior`. Scalars are only overwritten when the model
    supplies a non-null value, so a partial turn never nulls out earlier answers.
    occasion is never read from the parse at all: it's a pre-session modal field
    (host's Qa row), not a conversational one, so no chat turn can set it.

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
    added_pref = set(signals.preferred_cuisines) - set(prior.preferred_cuisines)
    added_dis = set(signals.disliked_cuisines) - set(prior.disliked_cuisines)
    if added_pref:
        signals.disliked_cuisines = [
            t for t in signals.disliked_cuisines if t not in added_pref
        ]
    if added_dis:
        signals.preferred_cuisines = [
            t for t in signals.preferred_cuisines if t not in added_dis
        ]
    # Dietary: controlled-vocabulary synonyms, no group expansion.
    signals.dietary_restrictions = _merge_dietary_field(
        prior.dietary_restrictions,
        _clean_tags(parsed.get("dietary_restrictions")),
        _clean_removals(parsed.get("removed_dietary")),
    )

    bmin = _coerce_int(parsed.get("budget_min"))
    if bmin is not None:
        signals.budget_min = bmin
    bmax = _coerce_int(parsed.get("budget_max"))
    if bmax is not None:
        signals.budget_max = bmax

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


def _fallback_reply(signals: ExtractedSignals, missing: list[str]) -> str:
    """Deterministic reply used only when the LLM's own reply is unusable.

    Confirms whatever is now captured and asks the next missing question — the
    same confirm-then-ask shape the prompt requests, so a degraded turn still
    behaves correctly for the user.
    """
    bits: list[str] = []
    if signals.disliked_cuisines:
        bits.append(f"you don't like {_summarize_tags(signals.disliked_cuisines)}")
    if signals.preferred_cuisines:
        bits.append(f"you're into {_summarize_tags(signals.preferred_cuisines)}")
    if signals.dietary_restrictions:
        bits.append(f"dietary: {', '.join(signals.dietary_restrictions)}")
    if signals.budget_max is not None:
        bits.append(f"budget up to ${signals.budget_max}")
    elif signals.budget_min is not None:
        bits.append(f"budget from ${signals.budget_min}")

    confirm = f"Got it, {'; '.join(bits)}." if bits else "Got it."
    if missing:
        return f"{confirm} {_QUESTION_FOR.get(missing[0], 'What else matters to you?')}"
    return f"{confirm} That's everything I need — thanks!"


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
        raw = await chat_completion(
            messages,
            temperature=0.2,
            provider=settings.active_extraction_provider,
            model=settings.active_extraction_model,
        ) or ""
    else:
        raw = await chat_completion(messages, temperature=0.2) or ""

    try:
        parsed = json.loads(strip_json_fence(raw))
    except (ValueError, TypeError):
        parsed = None

    if not isinstance(parsed, dict):
        missing = _compute_missing(prior, is_host=is_host)
        return TurnResult(
            signals=prior,
            agent_reply=_fallback_reply(prior, missing),
            missing_signals=missing,
            degraded=True,
        )

    raw_signals = parsed.get("extracted_signals")
    if not isinstance(raw_signals, dict):
        # Tolerate a model that put the signal fields at the top level.
        raw_signals = parsed

    signals = _reconcile(prior, raw_signals)
    missing = _clean_missing(parsed.get("missing_signals"), signals, is_host=is_host)

    if fast:
        # Low-latency mode asked the model NOT to write a reply, so the server
        # authors the whole line. _fallback_reply already produces exactly the
        # confirm-then-ask shape the prompt otherwise requests, and it walks the
        # canonical ask-order — which also makes the spoken wording deterministic
        # (what the voice/TTS path needs) rather than a model paraphrase.
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
    )
