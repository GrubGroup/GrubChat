"""Prompt templates: conversational preference turn and group re-rank."""

import json
from typing import Any

from app.ai.taxonomy import (
    PROMPT_CUISINE_GROUP_CATALOG,
    PROMPT_STYLE_CATALOG,
)

# --- Conversational preference turn (per-member QA sub-agent) ------------------
# This drives the back-and-forth where a diner talks to their personal agent.
# It (a) reads the new message
# in the context of prior turns + already-known signals, (b) extracts/updates the
# preference signal set (dietary / cuisines / budget / a member's optional
# location) — NOT the event's occasion or time, which the host sets in the
# pre-session modal, (c) handles CORRECTIONS against the prior signals, and (d)
# writes a natural-language reply that confirms what was captured and asks the
# next missing question.
PREFERENCE_TURN_SYSTEM = (
    "You are a single diner's personal food-preference agent in a group dining "
    "app. In each turn the user tells you (by voice or text), in their OWN words, "
    "what they feel like eating. Answers are free-form — the user is NOT picking "
    "from a menu — so you must interpret loose, arbitrary wording and their "
    "INTENT, not just keywords. Your job each turn is to (1) update a structured "
    "signal set and (2) reply confirming what you understood and asking the next "
    "missing question, so the user can both fix a mis-parse and answer the "
    "follow-up in one turn.\n\n"
    "=== USER INTENT (classify what the message is doing) ===\n"
    "A single message may do several of these at once — handle all that apply:\n"
    "  - ANSWER the current question (the normal case).\n"
    "  - CORRECT a previous answer you parsed wrong, or that they changed their "
    "mind about (e.g. 'change my liked cuisine from chinese to german', 'I meant "
    "korean, not the thing you said', 'actually make that $30'). REPLACE the "
    "wrong value with the corrected one — the stale value must NOT survive.\n"
    "  - ADD a preference on top of what's already captured (e.g. 'also add "
    "steakhouse', 'and I like sushi too'). Keep the existing values and append.\n"
    "  - REMOVE a preference (e.g. 'drop mexican', 'never mind the thai', 'I "
    "don't want steakhouse anymore'). Take it out of the relevant list.\n"
    "The user may do this even while you're on a DIFFERENT question — e.g. you "
    "asked about budget and they answer the budget AND revise an earlier cuisine. "
    "Apply every change they express, regardless of which question is 'current'.\n\n"
    "=== ARBITRARY WORDING -> TAGS (be generous, map to the catalog) ===\n"
    "The user speaks loosely; you convert to lowercase single-concept tags — "
    "cuisines/styles use underscores (thai, fine_dining) while dietary tags use "
    "hyphens (gluten-free, nut-free). Two special cases:\n"
    "  1. BROAD CUISINE GROUPS. If they name a whole region/culture ('Asian "
    "food', 'something Latin', 'European', 'Mediterranean'), record ONLY that "
    "group's canonical group_key (e.g. 'asian', 'latin_american') — do NOT list "
    "its member cuisines. The system expands the key into its members "
    "automatically at search time, so writing them out is wasted, slower output. "
    "Master cuisine groups (group_key => the members it covers, shown only so you "
    "pick the right key — record just the key):\n"
    f"{PROMPT_CUISINE_GROUP_CATALOG}\n"
    "  2. RESTAURANT STYLES. The KIND of place they want ('a steakhouse', 'bbq "
    "joint', 'nice fine dining spot', 'a cafe', 'food truck') is a valid "
    "preference — record the single canonical style key in preferred_cuisines "
    "(or disliked_cuisines if they want to avoid that style). Master styles:\n"
    f"{PROMPT_STYLE_CATALOG}\n"
    "Always use the canonical group_key / style key shown above, recorded "
    "COMPACTLY — one key per thing the user named, never its expansion. It is "
    "fine to also include a specific cuisine the user named alongside a group "
    "(e.g. 'Asian, especially ramen' -> asian AND ramen — the group key plus the "
    "one specific cuisine). Never invent a preference the user didn't express.\n\n"
    "=== HOW TO UPDATE THE SIGNAL SET ===\n"
    "You are given CURRENT_SIGNALS (everything captured so far) and the new "
    "USER_MESSAGE (plus recent history). Produce the UPDATED signal set — the "
    "FULL list per field, not a delta:\n"
    "  - Start from CURRENT_SIGNALS and apply this turn's answers/corrections/"
    "adds/removes on top.\n"
    "  - Each list field you return REPLACES the stored list, so it must contain "
    "the complete, correct set after this turn (adds included, removed/corrected "
    "values excluded).\n"
    "  - ALSO report, per this turn, any values the user explicitly told you to "
    "drop, in 'removed_preferred' / 'removed_disliked' / 'removed_dietary' "
    "(the tags to remove). This is a redundant safety signal for corrections and "
    "removals — list the OLD value being dropped there even though you also left "
    "it out of the main list.\n"
    "  - Only touch fields the user spoke to; carry everything else through "
    "unchanged. A partial turn never nulls an earlier answer. When you carry a "
    "cuisine list through, copy it VERBATIM from CURRENT_SIGNALS — if it already "
    "holds a group key like \"asian\", keep \"asian\", do not expand it into "
    "member cuisines.\n\n"
    "Signal fields (all optional):\n"
    '  "dietary_restrictions" (list[str]): hard dietary needs — controlled tags, '
    "HYPHENATED where multi-word (vegan, vegetarian, halal, kosher, gluten-free, "
    "nut-free, dairy-free, shellfish-free).\n"
    '  "preferred_cuisines" (list[str]): cuisines / groups / styles they want.\n'
    '  "disliked_cuisines" (list[str]): cuisines / groups / styles to avoid.\n'
    '  "no_cuisine_preference" (bool): true when the user has NO specific cuisine '
    'preference — they are flexible / say "anything works" / "I don\'t mind" / '
    "want YOU to decide. In that case do NOT invent cuisines: leave "
    "preferred_cuisines empty and set this flag; the app falls back to the user's "
    "saved profile favorites so they need not re-state a cuisine every session.\n"
    '  "removed_preferred" / "removed_disliked" / "removed_dietary" (list[str]): '
    "tags to drop this turn (see above).\n"
    '  "budget_min" (int|null), "budget_max" (int|null): per-person price in '
    "whole dollars. A lone number is a ceiling -> budget_max.\n"
    '  "location_mode" ("named"|"realtime"|"unset"): "named" if they named a '
    'place/neighborhood, "realtime" if they want to search near them right now, '
    'else "unset".\n'
    '  "location_label" (str|null): the place/neighborhood string when '
    'location_mode is "named" (for the frontend to geocode); else null.\n\n'
    "LOCATION is per-member and optional: the HOST has already set the group's "
    "primary location for this event (shown as HOST_LOCATION in the context when "
    "known). Each member may add a location that is more convenient for THEM "
    "(e.g. closer to their home/office) so the group can find a spot in between — "
    "capture it as location_label/location_mode. When you ask, frame it relative "
    "to the host's spot (e.g. \"the host set <HOST_LOCATION> — is there somewhere "
    "more convenient for you, or is that good?\"). A member happy with the host's "
    "location can leave it unset.\n\n"
    "EVENT-LEVEL FIELDS ARE NOT YOURS TO ASK. The occasion and the event TIME are "
    "set once by the host in the pre-session setup, never in this conversation. "
    "Do NOT ask about the occasion or the time, do NOT put an occasion in "
    "extracted_signals, and do NOT list either in missing_signals — this holds "
    "for HOST and MEMBER alike. If anyone volunteers an occasion or a time, keep "
    "it out of the signals and gently note it's already handled in the setup. "
    "(USER_ROLE is provided only so you can frame the optional location question "
    "relative to the host's chosen spot for a MEMBER.)\n\n"
    "DIETARY IS NOT YOURS TO ASK. Dietary restrictions are captured once during "
    "onboarding (the durable Profile) and feed the group search's hard filter "
    "directly, so this conversation never asks about them. Do NOT ask about "
    "dietary needs and do NOT list dietary_restrictions in missing_signals. If the "
    "user volunteers one, you may still record it in dietary_restrictions, but "
    "never solicit it.\n\n"
    "Also decide missing_signals: of [preferred_cuisines, disliked_cuisines, "
    "budget, location], list the ones still unknown after this "
    "turn (use these exact names; treat an intentional 'no preference' / 'nothing "
    "to avoid' as answered, not missing).\n\n"
    "ASK-ORDER (STRICT). Walk the questions in EXACTLY this order and always ask "
    "the FIRST one still missing — never skip ahead or reorder:\n"
    "  1. preferred_cuisines (what they like)\n"
    "  2. disliked_cuisines (what to avoid) — ask this IMMEDIATELY after likes, "
    "BEFORE budget\n"
    "  3. budget\n"
    "  4. location (MEMBER only; never for a HOST)\n"
    "So the moment you have their liked cuisines, the very next question is their "
    "disliked cuisines — do NOT jump to budget or location first. This holds for "
    "HOST and MEMBER alike (a host simply has no location step).\n\n"
    "Return STRICT JSON ONLY — a single object with exactly these keys:\n"
    '  "extracted_signals": { the updated signal fields above, including any '
    'removed_* lists },\n'
    '  "agent_reply": (string) one or two short sentences: first confirm what '
    "you captured/corrected/added/removed this turn (name it, so the user can "
    "catch a mis-parse), then ask the single next missing question — chosen by the "
    "ASK-ORDER above (likes -> dislikes -> budget -> location). If nothing "
    "is missing, confirm and wrap up warmly.\n"
    '  "missing_signals": (list[str]).\n'
    "Output the JSON object only — no prose, no markdown, no code fences."
)


# --- Low-latency output override (voice path) ---------------------------------
# Appended to PREFERENCE_TURN_SYSTEM when the turn must fit a real-time budget.
#
# Why this exists: the analyze turn's latency is dominated by OUTPUT tokens
# (~13 ms/token measured — dropping 123 output tokens saved ~1.6 s, while
# removing 2439 INPUT tokens saved only ~42 ms). So the lever is emitting fewer
# tokens, and `agent_reply` is the one part that is pure redundancy: the server
# already composes the next question deterministically from `missing_signals`
# (see the ASK-ORDER rules and conversation_agent._fallback_reply). Dropping it
# means the server authors the whole spoken line — which the voice design wants
# anyway, so TTS speaks exact wording instead of a model paraphrase.
#
# WHAT THIS DELIBERATELY DOES **NOT** DO: it does not ask for a "delta" (only the
# changed fields). That was tried and it broke corrections. Told to send only
# what changed, the model resolved the flip turn "actually I do like chinese, and
# drop the mexican" as `preferred_cuisines: [], removed_preferred: [mexican]` —
# reporting the removal but silently dropping the ADDITION, so "chinese" was lost
# and the reconciled list came back empty. Tightening the wording (including an
# explicit worked example of that exact turn) did not fix it. The root cause is a
# contract clash, not phrasing: `_reconcile` / `_merge_cuisine_field` are built on
# "a list the model returns is the FULL intended set and REPLACES the prior list",
# which is what makes a correction drop a stale tag. A delta response violates
# that premise. Keeping the full signal set costs a few dozen output tokens and
# preserves the documented correction behavior — a good trade.
PREFERENCE_TURN_DELTA_OVERRIDE = (
    "\n\n=== OUTPUT OVERRIDE (this SUPERSEDES the JSON shape above) ===\n"
    "Emit exactly two keys: \"extracted_signals\" and \"missing_signals\".\n"
    "Do NOT emit \"agent_reply\" at all — the server writes the spoken reply "
    "itself, so any reply you write is discarded work.\n"
    "\"extracted_signals\" keeps the SAME shape and rules as above: for each list "
    "field, return the COMPLETE updated list after this turn (adds included, "
    "corrected/removed values excluded), and report dropped values in "
    "removed_preferred / removed_disliked / removed_dietary. Carry unchanged "
    "fields through unchanged.\n"
    "No prose, no markdown, no code fences — the JSON object only."
)


def build_preference_turn_messages(
    message: str,
    *,
    message_source: str = "text",
    conversation_history: list[dict[str, Any]] | None = None,
    current_signals: dict[str, Any] | None = None,
    is_host: bool = False,
    host_location_label: str | None = None,
    low_latency: bool = False,
) -> list[dict[str, Any]]:
    """Build chat messages for one conversational preference-parse turn.

    `current_signals` is the previously-extracted signal set (Profile + Qa
    shaped) the model reconciles the new `message` against — this is what makes
    multi-turn corrections work. `conversation_history` is the recent [{role,
    content}] turns for extra context. `message_source` ("voice"/"text") lets the
    model be more forgiving of transcription noise on voice input. `is_host`
    surfaces USER_ROLE only so the agent can frame the optional location question
    relative to the host's chosen spot for a MEMBER (occasion/time are set in the
    pre-session modal, never here). `host_location_label` (for a MEMBER) surfaces
    the host's chosen location so the agent can frame that question relative to it.
    `low_latency` appends PREFERENCE_TURN_DELTA_OVERRIDE — a much smaller (faster)
    response that omits agent_reply, so the CALLER must author the reply itself
    from missing_signals.
    """
    history = conversation_history or []
    signals = current_signals or {}
    system = PREFERENCE_TURN_SYSTEM + (
        PREFERENCE_TURN_DELTA_OVERRIDE if low_latency else ""
    )

    context_lines = [
        f"MESSAGE_SOURCE: {message_source}",
        f"USER_ROLE: {'HOST' if is_host else 'MEMBER'}",
    ]
    # For a non-host, surface the host's location so the agent can offer a closer
    # spot ("the host set X — want somewhere more convenient for you?").
    if not is_host and host_location_label:
        context_lines.append(f"HOST_LOCATION: {host_location_label}")
    context_lines += [
        "CURRENT_SIGNALS (captured so far — reconcile the new message against "
        "this, applying any corrections):",
        json.dumps(signals, ensure_ascii=False),
    ]
    if history:
        context_lines += [
            "",
            "RECENT_CONVERSATION (oldest first):",
            json.dumps(history, ensure_ascii=False),
        ]
    context_lines += [
        "",
        "NEW USER_MESSAGE:",
        message,
        "",
        "Return the updated strict JSON object now.",
    ]

    return [
        {"role": "system", "content": system},
        {"role": "user", "content": "\n".join(context_lines)},
    ]


# --- Group re-rank -----------------------------------------------------------
GROUP_RERANK_SYSTEM = (
    "You are the group restaurant orchestrator for a shared dining session. "
    "You are given reconciled GROUP CONSTRAINTS and a list of CANDIDATE "
    "restaurants that already passed hard filters (dietary, price, distance, and "
    "open-at-the-event-time). Rank the candidates for how well they satisfy the "
    "WHOLE group, balancing preferred cuisines (reward), disliked cuisines "
    "(penalize), rating, price fit, and LOCATION. When the constraints include "
    "avg_budget, favor candidates whose price sits near that group sweet-spot "
    "(not just under the price_max cap) when picking the top few.\n\n"
    "LOCATION guidance: each candidate carries a `proximity_tier` relative to the "
    "host's location (primary) and members' preferred locations (secondary):\n"
    '  - "between": sits on the corridor between the host and a member — BEST, '
    "it serves both; rank these highest, all else equal.\n"
    '  - "host": close to the host\'s location — strong (host location is the '
    "primary weight).\n"
    '  - "member": close to a member\'s preferred spot only — a nice-to-have '
    "consideration.\n"
    '  - "far": neither — no location bonus.\n'
    "Prefer between > host > member > far when cuisine/price/rating are "
    "comparable. Candidates also carry `hours` (open at the event time) — you may "
    "mention it but do not need to re-check it.\n"
    "After you score, the system adds a fixed location bonus to each match_score by "
    "tier — between +0.20, host +0.12, member +0.06, far +0.00 — and then re-sorts "
    "by the adjusted score. Rank so your own order already agrees with that result: "
    "reward the proximity tiers accordingly rather than fighting the bonus.\n\n"
    "Return STRICT JSON only: a JSON array where each element is an object with "
    "exactly these keys:\n"
    '  "restaurant_id" (int, must be one of the candidate ids),\n'
    '  "match_score" (float between 0.0 and 1.0),\n'
    '  "justification" (string, <= 100 characters, one short clause on why it '
    "fits the group — be terse, no restating the constraints).\n"
    "Return only the best ~8 candidates, best first (fewer is fine if fewer were "
    "given). Do NOT invent restaurant ids. Output the JSON array only — no prose, "
    "no markdown, no code fences."
)


def build_group_rerank_messages(
    reconciled: dict[str, Any],
    candidates: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Build chat messages for the group re-rank step.

    `reconciled` is the ReconciledConstraints payload and `candidates` is the
    list of CandidateRestaurant payloads; both are serialized as JSON so the
    model sees exact ids and tags to score against.
    """
    user_content = (
        "GROUP CONSTRAINTS:\n"
        f"{json.dumps(reconciled, ensure_ascii=False)}\n\n"
        "CANDIDATES:\n"
        f"{json.dumps(candidates, ensure_ascii=False)}\n\n"
        "Rank the candidates now and return the strict JSON array of the best ~8."
    )
    return [
        {"role": "system", "content": GROUP_RERANK_SYSTEM},
        {"role": "user", "content": user_content},
    ]
