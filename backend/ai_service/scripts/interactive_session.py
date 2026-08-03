"""Interactive, type-your-own-answers walkthrough of the preference sub-agent.

This is the *interactive* sibling of ``scripts/demo_orchestrator.py``. Where the
demo scripts every member's Q&A answers as canned strings, THIS script hands the
keyboard to a tester: you play ONE member and *type* free-text answers to your
own AI preference sub-agent, watch it echo back what it captured, and then the
real master orchestrator reconciles the whole group and produces the TOP-5
restaurant picks. The other members auto-fill from the demo personas.

It is the terminal preview of the frontend ``AgentChatPage`` flow: a member
chats with their personal agent, a "noted so far" panel fills in, they finish
sharing, and the group lands on a shortlist (``TopPicksPage``).

Two important honesty notes — the same spirit as the demo's mocked providers:

  * **There is no wired free-text -> preferences logic in the backend.** The real
    ``normalize_member`` (app/ai/agents/preference_agent.py) is deterministic: it
    copies structured ``Profile`` columns straight through. So this script does
    the extraction itself — offline via a deterministic keyword/regex extractor
    over the *real* seed-catalog vocabulary (default), or via the real LLM under
    ``--live`` — then hands a structured Profile dict to the REAL
    ``normalize_member``. The resulting ``MemberPref`` is genuinely the agent's.
  * **The sub-agent's spoken reply is a templated UX stand-in.** The backend has
    no reply-generation logic (just like the demo's ``_mock_rerank_response``).
    The captured *signals* are real; only the conversational phrasing is scripted.

Modes:

  * DEFAULT (offline): no DB, no API keys, deterministic. Extraction is a local
    keyword/regex pass; retrieval + re-rank reuse the demo's offline stand-ins
    over the real seed catalog. Runs anywhere, including CI (piped stdin).
  * ``--live``: real OpenRouter embeddings + real pgvector search + real
    Salesforce/Claude extraction & re-rank, over the mock group. Needs a running
    DB + API keys (like the smoke test). Read/compute only — no rows written.

Run:
    cd backend/ai_service
    uv run python -m scripts.interactive_session                    # you play Alice (vegan)
    uv run python -m scripts.interactive_session --member bob        # play a different persona
    uv run python -m scripts.interactive_session --all-interactive   # type for every member
    uv run python -m scripts.interactive_session --answers-file a.txt # feed answers from a file
    uv run python -m scripts.interactive_session --live              # real backend path
    printf 'vegan\\nthai\\nno steak\\n$15 to 40\\n' | uv run python -m scripts.interactive_session

In-conversation commands: ``:skip`` (skip this question), ``:done`` (stop early),
``:quit`` (abort), ``:help`` (show commands).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
from typing import Any

# --- Real pipeline building blocks (the sub-agent output is genuinely real) ---
import app.ai.agents.conversation_agent as conversation_agent
from app.ai.agents.conversation_agent import analyze_turn
from app.ai.agents.preference_agent import normalize_member
from app.ai.budget import is_no_cap
from app.ai.graph.state import MemberPref, PipelineState
from app.schemas.ai import ConversationTurn, ExtractedSignals

# --- Reused verbatim from the demo (single source of truth; no drift) ---------
# Styling, narration helpers, the offline seed catalog, the shared fixtures, the
# analyze-turn offline stand-in + MemberPref assembly, and the whole narrated
# orchestrator/top-picks/reconcile steps all come from the demo so the two
# scripts stay identical where they overlap. Cross-``_``-import is an established
# pattern in this scripts/ package.
from scripts.demo_orchestrator import (
    Ink,
    _DEMO_SCHEDULED_FOR,
    _DEMO_SESSION_ID,
    _MEMBERS,
    _SESSION_QA,
    _agent_says,
    _banner,
    _build_member_pref,
    _fmt_tags,
    _install_offline_turn,
    _kv,
    _live_preflight,
    _load_mock_catalog,
    _make_ink,
    _note,
    _print_orchestrate_and_rank,
    _print_reconcile,
    _print_session_qa,
    _print_top_picks,
    _rule,
    _step,
    _substep,
    _user_says,
)


# ---------------------------------------------------------------------------
# Offline extractor — deterministic free-text -> structured signals.
#
# The backend has no free-text extraction, so we do it here (offline default).
# Everything below is pure, case-insensitive, and driven by the REAL seed-catalog
# vocabulary so any tag we extract is one the retriever can actually match.
# ---------------------------------------------------------------------------

# Canonical dietary tags are exactly the six the seed catalog carries. Anything
# outside this set can't be satisfied by the retriever's `@>` superset filter, so
# we map known synonyms onto these and drop the rest (with a visible note).
# Multi-word / phrase keys are listed first and matched before single words.
_DIETARY_SYNONYMS: list[tuple[str, str]] = [
    ("gluten free", "gluten_free"),
    ("gluten-free", "gluten_free"),
    ("no gluten", "gluten_free"),
    ("celiac", "gluten_free"),
    ("coeliac", "gluten_free"),
    ("tree nut", "nut_free"),
    ("tree nuts", "nut_free"),
    ("nut allergy", "nut_free"),
    ("nut-free", "nut_free"),
    ("nut free", "nut_free"),
    ("no nuts", "nut_free"),
    ("peanut", "nut_free"),
    ("vegan", "vegan"),
    ("vegetarian", "vegetarian"),
    ("veggie", "vegetarian"),
    ("halal", "halal"),
    ("kosher", "kosher"),
    ("gf", "gluten_free"),
]

# Extra cuisine phrasings not literally in the catalog vocabulary (singular /
# plural / near-words). The catalog tags themselves are matched dynamically.
_CUISINE_SYNONYMS: dict[str, str] = {
    "steak": "steakhouse",
    "steaks": "steakhouse",
    "banh mi": "vietnamese",
    "pho": "vietnamese",
    "veggie bowl": "bowls",
    "poke bowl": "poke",
}

# Pure negation / "no preference" answers -> capture nothing for that field.
_SKIP_ANSWERS: frozenset[str] = frozenset(
    {
        "",
        "no",
        "none",
        "nope",
        "nah",
        "nothing",
        "n/a",
        "na",
        "skip",
        "anything",
        "anything works",
        "anything's fine",
        "whatever",
        "no preference",
        "no preferences",
        "no restrictions",
        "no restriction",
        "none really",
        "no thanks",
        "nothing to avoid",
        "nothing off the table",
        "flexible",
        "i'm flexible",
        "im flexible",
        "open to anything",
    }
)


def _normalize(text: str) -> str:
    """Lowercase + collapse whitespace for matching."""
    return re.sub(r"\s+", " ", text.strip().lower())


def _is_skip(answer: str) -> bool:
    """True when the answer means 'no / none / flexible' (capture nothing)."""
    return _normalize(answer) in _SKIP_ANSWERS


def _cuisine_vocab() -> set[str]:
    """Union of every cuisine tag across the real seed catalog (the vocabulary)."""
    vocab: set[str] = set()
    for restaurant in _load_mock_catalog():
        vocab.update(restaurant.cuisine_tags)
    return vocab


def _extract_cuisines(answer: str, vocab: set[str]) -> list[str]:
    """Match catalog cuisine tags (and a few synonyms) as whole words in `answer`."""
    text = _normalize(answer)
    found: list[str] = []

    def _add(tag: str) -> None:
        if tag not in found:
            found.append(tag)

    # Catalog tags: match the tag itself and its de-underscored variant
    # (so "fine dining" matches `fine_dining`, "dim sum" -> `dim_sum`, etc.).
    for tag in sorted(vocab, key=len, reverse=True):
        variants = {tag, tag.replace("_", " ")}
        for variant in variants:
            if re.search(rf"\b{re.escape(variant)}\b", text):
                _add(tag)
                break

    # Hand synonyms for common phrasings not literally in the vocabulary.
    for phrase, tag in _CUISINE_SYNONYMS.items():
        if re.search(rf"\b{re.escape(phrase)}\b", text):
            _add(tag)

    return found


def _extract_dietary(answer: str) -> list[str]:
    """Map dietary synonyms in `answer` onto the six canonical catalog tags."""
    text = _normalize(answer)
    found: list[str] = []
    for phrase, tag in _DIETARY_SYNONYMS:
        if tag in found:
            continue
        if re.search(rf"\b{re.escape(phrase)}\b", text):
            found.append(tag)
    return found


def _extract_budget(answer: str) -> tuple[int | None, int | None]:
    """Parse a per-person budget from free text -> (min, max), either may be None.

    Ordered passes: explicit range, upper bound, lower bound, then a lone number
    treated as a ceiling (matching `_reconcile`'s tightest-cap logic).
    """
    text = _normalize(answer)

    m = re.search(r"(\d{1,4})\s*(?:-|–|to|through|and|thru)\s*\$?\s*(\d{1,4})", text)
    if m:
        lo, hi = int(m.group(1)), int(m.group(2))
        return (min(lo, hi), max(lo, hi))

    m = re.search(
        r"(?:under|below|less than|max|maximum|up to|no more than|at most|"
        r"cap(?:ped)?(?:\s*at)?)\s*\$?\s*(\d{1,4})",
        text,
    )
    if m:
        return (None, int(m.group(1)))

    m = re.search(
        r"(?:over|above|at least|min(?:imum)?|more than|starting at|from)\s*\$?\s*(\d{1,4})",
        text,
    )
    if m:
        return (int(m.group(1)), None)

    nums = re.findall(r"\d{1,4}", text)
    if nums:
        return (None, int(nums[0]))  # a lone number -> treat as the ceiling
    return (None, None)


# ---------------------------------------------------------------------------
# Offline delta builder — typed answer -> the analyze-turn "extracted_signals"
# an LLM would return. Feeding this to the demo's offline analyze stand-in makes
# the REAL analyze_turn run its expansion/reconcile/reply logic over it. In
# --live mode this is unused: the raw typed answer goes straight to the gateway.
# ---------------------------------------------------------------------------


# A few SF neighborhoods -> approximate (lat, lon), so an offline location answer
# yields a real secondary anchor for the between-host-and-member ranking (offline
# has no geocoder; --live geocodes the free-text label for real).
_KNOWN_PLACES: list[tuple[str, float, float]] = [
    ("mission", 37.7599, -122.4148),
    ("downtown", 37.7749, -122.4194),
    ("soma", 37.7785, -122.4056),
    ("marina", 37.8030, -122.4370),
    ("oakland", 37.8044, -122.2712),
    ("berkeley", 37.8715, -122.2730),
    ("office", 37.7899, -122.4000),
]


def _extract_delta(answer: str, field: str, vocab: set[str]) -> dict[str, Any]:
    """Offline extractor: one typed `answer` for `field` -> an analyze-turn delta.

    Produces the SAME delta shape ``demo_orchestrator`` feeds its offline analyze
    stand-in (keys ``dietary`` / ``preferred`` / ``disliked`` / ``budget_*`` /
    ``location_*``), so ``_install_offline_turn`` can turn it into canned LLM JSON
    and the real ``analyze_turn`` then expands broad terms ("asian" -> its
    cuisines), records styles ("steakhouse"), and reconciles. The extractor
    matches against the real seed-catalog vocabulary, so any tag it finds is one
    the retriever can match; broad group words (asian / latin / mediterranean) and
    style words (steakhouse / bbq / cafe) are catalog tags too, so they extract
    then expand.
    """
    if field == "budget":
        bmin, bmax = _extract_budget(answer)
        return {"budget_min": bmin, "budget_max": bmax}
    if _is_skip(answer):
        return {field: []}
    if field == "dietary":
        return {"dietary": _extract_dietary(answer)}
    if field == "location":
        # Match a known neighborhood to coords (the offline stand-in for geocoding
        # the member's preferred spot). No match -> no anchor (happy with host's).
        text = _normalize(answer)
        for name, lat, lon in _KNOWN_PLACES:
            if name in text:
                return {
                    "location_label": answer.strip(),
                    "location_mode": "named",
                    "location_lat": lat,
                    "location_lon": lon,
                }
        return {}
    # preferred / disliked both draw from the cuisine vocabulary.
    return {field: _extract_cuisines(answer, vocab)}


# ---------------------------------------------------------------------------
# stdin / answer source — TTY input, piped buffer, or --answers-file.
# ---------------------------------------------------------------------------


class _QuitInteractive(Exception):
    """Raised on :quit / Ctrl-D / Ctrl-C to abort the session gracefully."""


class _AnswerSource:
    """Where a member's answers come from: live TTY, a piped buffer, or a file.

    ``next()`` returns ``(text, origin)`` for a real answer, or ``None`` when a
    finite source (buffer/file) is exhausted — the caller then falls back to the
    persona's saved answer. In TTY mode, EOF/interrupt raises ``_QuitInteractive``.
    """

    def __init__(
        self,
        *,
        interactive: bool,
        buffered_lines: list[str] | None = None,
    ) -> None:
        self.interactive = interactive
        self._lines = buffered_lines
        self._idx = 0

    def next(self, prompt: str) -> tuple[str, str] | None:
        if self.interactive:
            try:
                return (input(prompt), "typed")
            except (EOFError, KeyboardInterrupt):
                raise _QuitInteractive from None
        # Finite buffered source (piped stdin or --answers-file).
        if self._lines is None or self._idx >= len(self._lines):
            return None
        line = self._lines[self._idx]
        self._idx += 1
        return (line, "buffered")


def _classify_command(answer: str) -> str | None:
    """Recognize in-band commands; return ':skip'/':done'/':quit'/':help' or None."""
    token = _normalize(answer)
    if token in (":skip", ":done", ":quit", ":help"):
        return token
    return None


def _stdin_is_tty() -> bool:
    try:
        return sys.stdin.isatty()
    except (ValueError, AttributeError):
        return False


# ---------------------------------------------------------------------------
# The interactive sub-agent conversation.
# ---------------------------------------------------------------------------

# Ordered questions: preferred -> disliked -> budget -> location. Order matches
# the personas' analyze_turns and the reconcile inputs. Dietary is NOT asked here
# — it's captured once in onboarding (durable Profile) and feeds the ranking hard
# filter directly. Answer in your OWN words — broad groups ("Asian food"), styles
# ("a steakhouse"), and mid-chat corrections ("actually, change chinese to
# korean") are all understood by the real agent. The location question is
# per-member and optional (relative to the host's spot). Chips mirror
# AgentChatPage's quick-reply affordances.
_QUESTIONS: list[dict[str, Any]] = [
    {
        "field": "preferred",
        "prompt": (
            "Hi {name}! I'm your food agent for this session. First — what sounds "
            "good today? Name a cuisine, a whole vibe (\"Asian\", \"something "
            "Mediterranean\"), or a kind of spot (\"a steakhouse\")."
        ),
        "chips": ["Asian food", "Italian", "A steakhouse", "Anything works"],
    },
    {
        "field": "disliked",
        "prompt": (
            "Are there any cuisines you dislike or want to avoid? (You can also "
            "revise an earlier answer here — e.g. \"actually, swap chinese for "
            "korean\".)"
        ),
        "chips": ["No steakhouses", "Nothing fancy", "No BBQ", "Nothing to avoid"],
    },
    {
        "field": "budget",
        "prompt": "And your comfortable price range per person?",
        "chips": ["$15–20pp", "Under $20", "$20–40", "I'm flexible"],
    },
    {
        "field": "location",
        "prompt": (
            "The host set the meeting spot for this event. Want to name a place "
            "that's more convenient for you (so we can find somewhere in between), "
            "or are you happy with theirs?"
        ),
        "chips": ["Near the Mission", "Downtown's fine", "By the office", "Wherever works"],
    },
]


def _print_chips(ink: Ink, chips: list[str]) -> None:
    print(f"    {ink.dim('quick replies: [ ' + '  ·  '.join(chips) + ' ]')}")


def _render_noted(ink: Ink, signals: ExtractedSignals, answered: set[str]) -> None:
    """Print the running 'noted so far' panel (✓ captured / ○ pending).

    Reads the REAL reconciled ExtractedSignals (post group/style expansion), so
    a broad "Asian" answer shows its expanded member cuisines here, capped by
    ``_fmt_tags`` so the panel stays readable.
    """

    def _row(field: str, label: str, value: str) -> str:
        if field not in answered:
            return f"      {ink.dim('○ ' + label + ': pending')}"
        return f"      {ink.good('✓')} {ink.dim(label + ':')} {value}"

    diet = ", ".join(signals.dietary_restrictions) or "no restrictions"
    pref = _fmt_tags(signals.preferred_cuisines) if signals.preferred_cuisines else "open"
    dis = _fmt_tags(signals.disliked_cuisines) if signals.disliked_cuisines else "nothing"
    bmin, bmax = signals.budget_min, signals.budget_max
    # NO_CAP (0) first: an "I'm flexible" answer is a real answer, not an absent
    # one, and it must not render as "$0" or as pending.
    if is_no_cap(bmax):
        budget = "flexible (no ceiling)"
    elif bmin and bmax:
        budget = f"${bmin}–{bmax}"
    elif bmax:
        budget = f"up to ${bmax}"
    elif bmin:
        budget = f"from ${bmin}"
    else:
        budget = "group ceiling"

    if signals.location_label:
        loc = signals.location_label
        if signals.location_lat is not None and signals.location_lon is not None:
            loc += f" ({signals.location_lat:.4f}, {signals.location_lon:.4f})"
    else:
        loc = "host's spot"

    print(f"    {ink.dim('— noted so far —')}")
    print(_row("dietary", "dietary", diet))
    print(_row("preferred", "likes", pref))
    print(_row("disliked", "avoids", dis))
    print(_row("budget", "budget", budget))
    print(_row("location", "your spot", loc))


async def _drive_turn(
    ink: Ink,
    name: str,
    answer: str,
    field: str,
    prior: ExtractedSignals,
    history: list[ConversationTurn],
    *,
    live: bool,
    is_host: bool,
    vocab: set[str],
) -> ExtractedSignals:
    """Run ONE answer through the REAL analyze_turn; print its reply; return signals.

    Offline: the deterministic extractor turns the typed answer into an
    analyze-turn delta, installed as the LLM stand-in so the real agent expands
    groups/styles and reconciles. Live: the raw answer goes to the real gateway.
    Either way, analyze_turn owns the parse/reconcile/reply — this is exactly the
    production path a single member turn takes.
    """
    if not live:
        delta = _extract_delta(answer, field, vocab)
        _install_offline_turn(delta, prior)

    result = await analyze_turn(
        answer,
        current_signals=prior,
        conversation_history=history,
        is_host=is_host,
    )
    history += [
        ConversationTurn(role="user", content=answer),
        ConversationTurn(role="assistant", content=result.agent_reply),
    ]
    _agent_says(ink, f"{name}'s Agent", result.agent_reply)
    return result.signals


async def _run_interactive_member(
    ink: Ink,
    member: dict[str, Any],
    source: _AnswerSource,
    *,
    live: bool,
    is_host: bool,
    vocab: set[str],
) -> MemberPref:
    """Drive one member's typed conversation through analyze_turn -> MemberPref.

    Each typed answer is reconciled by the REAL analyze_turn against everything
    said so far, so a broad "Asian" answer expands, a style ("a steakhouse") is
    captured, and a mid-conversation correction ("swap chinese for korean")
    drops the stale tag. The accumulated ExtractedSignals becomes this member's
    Qa override, merged over their durable Profile exactly as the pipeline does.
    """
    name = member["display_name"]
    persona_answers = [answer for _q, answer, *_ in member["analyze_turns"]]
    signals = ExtractedSignals()
    history: list[ConversationTurn] = []
    answered: set[str] = set()
    fallback_noted = False

    print()
    _rule(ink, "·")
    role = ink.dim(" (host)") if is_host else ""
    print(
        f"    {ink.agent(ink.bold('▷ Preference sub-agent for ' + name))}{role} "
        f"{ink.dim('(' + member['persona'] + ')')}"
    )
    print(f"    {ink.dim('Type your answer, or use :skip / :done / :quit / :help.')}")
    print()

    idx = 0
    while idx < len(_QUESTIONS):
        question = _QUESTIONS[idx]
        field = question["field"]

        _print_chips(ink, question["chips"])
        _agent_says(ink, f"{name}'s Agent", question["prompt"].format(name=name))

        result = source.next(ink.user("    you ▸ "))
        if result is None:
            # Finite source exhausted — auto-answer from the saved persona.
            if not fallback_noted:
                _note(
                    ink,
                    f"input exhausted — auto-answering the rest from {name}'s "
                    "saved profile.",
                )
                fallback_noted = True
            answer = persona_answers[idx] if idx < len(persona_answers) else ""
            origin = "persona"
        else:
            answer, origin = result

        command = _classify_command(answer)
        if command == ":quit":
            raise _QuitInteractive
        if command == ":help":
            _note(
                ink,
                ":skip = skip this question · :done = finish now · :quit = abort",
            )
            continue  # re-ask the same question
        if command == ":done":
            _note(ink, "finishing early — normalizing with what you've shared.")
            break
        if command == ":skip":
            answer = ""

        # In a live TTY the terminal already echoed the typed line; otherwise
        # render it into the styled stream so the transcript reads cleanly.
        if origin != "typed":
            _user_says(ink, name, answer or "(skipped)")

        # Skips / pure "no preference" turns capture nothing — don't bother the
        # agent (offline it would extract []; keep the transcript honest instead).
        if answer.strip() and not _is_skip(answer):
            signals = await _drive_turn(
                ink, name, answer, field, signals, history,
                live=live, is_host=is_host, vocab=vocab,
            )
        answered.add(field)

        _render_noted(ink, signals, answered)
        idx += 1

    # Merge the reconciled session signals over the durable Profile exactly as
    # the pipeline does (dietary stays on Profile — Qa has no dietary column),
    # then normalize via the REAL preference agent.
    merged = _build_member_pref(member["profile"], signals)
    pref = await normalize_member(merged)

    print()
    _substep(ink, f"SUB-AGENT OUTPUT → MemberPref for {name} (Profile + Qa overrides):")
    _kv(ink, "user_id", str(pref.user_id))
    _kv(ink, "dietary_restrictions (HARD, Profile)", str(pref.dietary_restrictions))
    _kv(ink, "preferred (profile)", str(pref.preferred_cuisines))
    _kv(ink, "qa_preferred (override)", _fmt_tags(pref.qa_preferred_cuisines))
    _kv(ink, "qa_disliked (override)", _fmt_tags(pref.qa_disliked_cuisines))
    cap = pref.effective_budget_cap
    _kv(ink, "effective budget ceiling", f"${cap}" if cap is not None else "none")
    if cap is None:
        _note(
            ink,
            "no personal budget ceiling — the member said 'I'm flexible' this "
            "session (which also drops their saved Profile budget) or has no "
            "budget data. Reconcile leaves them out of the caps entirely, so "
            "they neither constrain nor loosen the group's budget scoring.",
        )
    print(f"    {ink.agent('✔ END OF SUB-AGENT CONVERSATION for ' + name)}")
    return pref


async def _run_scripted_member(
    ink: Ink, member: dict[str, Any], *, live: bool, is_host: bool
) -> MemberPref:
    """Auto-fill a non-played member: their scripted answers still run analyze_turn.

    Same real agent path as the interactive member — each canned answer is
    reconciled by analyze_turn — so an auto-filled diner exercises the identical
    expansion/correction logic. Offline, the fixture's own ``offline_delta`` is
    fed to the analyze stand-in (exactly as ``demo_orchestrator`` does), which is
    more faithful than re-running the keyword extractor over canned prose; live,
    the raw answer hits the gateway.
    """
    name = member["display_name"]
    print()
    _rule(ink, "·")
    role = ink.dim(" (host)") if is_host else ""
    print(
        f"    {ink.agent(ink.bold('▷ Preference sub-agent for ' + name))}{role} "
        f"{ink.dim('(' + member['persona'] + ')')} {ink.dim('· auto-filled')}"
    )
    print()

    signals = ExtractedSignals()
    history: list[ConversationTurn] = []
    for question, answer, delta in member["analyze_turns"]:
        _agent_says(ink, f"{name}'s Agent", question)
        _user_says(ink, name, answer)
        if not live:
            _install_offline_turn(delta, signals)
        result = await analyze_turn(
            answer,
            current_signals=signals,
            conversation_history=history,
            is_host=is_host,
        )
        signals = result.signals
        history += [
            ConversationTurn(role="user", content=answer),
            ConversationTurn(role="assistant", content=result.agent_reply),
        ]
        print(f"    {ink.dim('↳ agent:')} {ink.dim(result.agent_reply)}")

    merged = _build_member_pref(member["profile"], signals)
    pref = await normalize_member(merged)

    print()
    _substep(ink, f"SUB-AGENT OUTPUT → MemberPref for {name} (Profile + Qa overrides):")
    _kv(ink, "dietary_restrictions (HARD, Profile)", str(pref.dietary_restrictions))
    _kv(ink, "preferred (profile)", str(pref.preferred_cuisines))
    _kv(ink, "qa_preferred (override)", _fmt_tags(pref.qa_preferred_cuisines))
    _kv(ink, "qa_disliked (override)", _fmt_tags(pref.qa_disliked_cuisines))
    cap = pref.effective_budget_cap
    _kv(ink, "effective budget ceiling", f"${cap}" if cap is not None else "none")
    print(f"    {ink.agent('✔ END OF SUB-AGENT CONVERSATION for ' + name)}")
    return pref


async def _collect_member_prefs(
    ink: Ink,
    source: _AnswerSource,
    played: dict[str, Any],
    *,
    live: bool,
    all_interactive: bool,
    vocab: set[str],
) -> list[MemberPref]:
    """STEP 3/6: preference sub-agents (interactive for you, auto-filled for others)."""
    _step(ink, "3/6", "PREFERENCE SUB-AGENTS (you type; others auto-fill)")
    _note(
        ink,
        "Each diner's answers run through the REAL analyze_turn (parse/expand/"
        "reconcile) then normalize_member.",
    )
    if not live:
        _note(
            ink,
            "Offline: your typed answers are turned into the analyze-turn signals "
            "an LLM would return via a deterministic keyword/regex extractor over "
            "the seed-catalog vocabulary, then the real agent expands + reconciles.",
        )

    prefs: list[MemberPref] = []
    for i, member in enumerate(_MEMBERS):
        # Member #1 (index 0) is the host — only they may set the occasion.
        is_host = i == 0
        interactive_here = all_interactive or member["username"] == played["username"]
        if interactive_here:
            prefs.append(
                await _run_interactive_member(
                    ink, member, source, live=live, is_host=is_host, vocab=vocab
                )
            )
        else:
            prefs.append(
                await _run_scripted_member(
                    ink, member, live=live, is_host=is_host
                )
            )
    return prefs


# ---------------------------------------------------------------------------
# Roster / intro / outro.
# ---------------------------------------------------------------------------


def _print_intro(ink: Ink, live: bool, played: dict[str, Any], all_interactive: bool) -> None:
    _banner(ink, "GrubGroup · Preference Sub-Agent — Interactive Terminal Session")
    mode = (
        ink.warn("LIVE (real DB + embeddings + Claude)")
        if live
        else ink.good("OFFLINE (no DB, no API keys, deterministic)")
    )
    print(f"  Mode: {mode}")
    if all_interactive:
        who = ink.user(ink.bold("all four members"))
    else:
        who = f"{ink.user(ink.bold(played['display_name']))} {ink.dim('(' + played['persona'] + ')')}"
    print(f"  You are playing: {who}")
    print(
        "  "
        + ink.dim(
            "Talk to your AI preference agent by typing answers; it echoes what it\n"
            "  captured, then the master orchestrator picks restaurants for the "
            "whole group."
        )
    )


def _print_roster(ink: Ink, played: dict[str, Any], all_interactive: bool) -> None:
    _step(ink, "1/6", "THE GROUP (who is in this session)")
    print(
        f"    {ink.dim('Session id (demo):')} {_DEMO_SESSION_ID}   "
        f"{ink.dim('members:')} {len(_MEMBERS)}"
    )
    print()
    for i, member in enumerate(_MEMBERS, start=1):
        host = ink.dim("  (host)") if i == 1 else ""
        you = (
            f"  {ink.good('← you (interactive)')}"
            if all_interactive or member["username"] == played["username"]
            else ""
        )
        print(
            f"    {i}. {ink.user(ink.bold(member['display_name']))} "
            f"{ink.dim('@' + member['username'])}{host}{you}"
        )
        print(f"       {ink.dim(member['persona'])}")


def _print_outro(ink: Ink, live: bool) -> None:
    _rule(ink)
    print(
        f"  {ink.good('✔ DONE.')} "
        + ink.dim("Terminal preview of the member → sub-agent → group-picks flow.")
    )
    if not live:
        print(
            "  "
            + ink.dim(
                "When wired to the frontend, your typed answers arrive as real "
                "voice/text and go\n  straight to analyze_turn on the real LLM "
                "(no offline stand-in), with the mock\n  catalog replaced by the "
                "seeded Postgres. Run --live to exercise that path."
            )
        )
    print()


# ---------------------------------------------------------------------------
# Member resolution + entry point.
# ---------------------------------------------------------------------------


def _resolve_member(name: str | None) -> dict[str, Any]:
    """Map --member (name / username / short name / 1-based index) to a persona."""
    if not name:
        return _MEMBERS[0]  # default: demo_alice (vegan)
    key = name.strip().lower()
    for member in _MEMBERS:
        candidates = {
            member["username"].lower(),
            member["display_name"].lower(),
            member["username"].lower().removeprefix("demo_"),
        }
        if key in candidates:
            return member
    if key.isdigit():
        idx = int(key) - 1
        if 0 <= idx < len(_MEMBERS):
            return _MEMBERS[idx]
    valid = ", ".join(m["username"].removeprefix("demo_") for m in _MEMBERS)
    raise SystemExit(f"Unknown --member {name!r}. Choose one of: {valid} (or 1–{len(_MEMBERS)}).")


def _build_answer_source(ink: Ink, answers_file: str | None) -> _AnswerSource:
    """Decide where answers come from and print a notice when non-interactive."""
    if answers_file:
        try:
            with open(answers_file, encoding="utf-8") as handle:
                lines = handle.read().splitlines()
        except OSError as exc:
            raise SystemExit(f"Cannot read --answers-file {answers_file!r}: {exc}") from exc
        _note(ink, f"Reading answers from {answers_file} (non-interactive).")
        return _AnswerSource(interactive=False, buffered_lines=lines)

    if _stdin_is_tty():
        return _AnswerSource(interactive=True)

    # Piped / non-TTY (e.g. CI): consume buffered stdin, fall back to personas.
    buffered = sys.stdin.read().splitlines() if not sys.stdin.closed else []
    _note(
        ink,
        "stdin is not a TTY — consuming piped answers, then falling back to each "
        "persona's saved answers.",
    )
    return _AnswerSource(interactive=False, buffered_lines=buffered)


async def _run(args: argparse.Namespace) -> int:
    ink = _make_ink(args.no_color)
    played = _resolve_member(args.member)

    _print_intro(ink, args.live, played, args.all_interactive)

    if args.live:
        if not await _live_preflight(ink):
            return 0  # environment issue, not a code bug — degrade gracefully.

    _print_roster(ink, played, args.all_interactive)
    _print_session_qa(ink)  # reused from the demo (STEP 2/6)

    source = _build_answer_source(ink, args.answers_file)

    try:
        prefs = await _collect_member_prefs(
            ink,
            source,
            played,
            live=args.live,
            all_interactive=args.all_interactive,
            vocab=_cuisine_vocab(),
        )
    except _QuitInteractive:
        print()
        _note(ink, "Session aborted (:quit). No picks generated.")
        return 0

    state = PipelineState(
        session_id=_DEMO_SESSION_ID,
        qa=_SESSION_QA,
        members=prefs,
        scheduled_for=_DEMO_SCHEDULED_FOR,
    )

    reconciled = _print_reconcile(ink, state)  # reused (STEP 4/6)
    state.reconciled = reconciled

    try:
        ranked = await _print_orchestrate_and_rank(  # reused (STEP 5/6)
            ink, state, reconciled, live=args.live, top_n=args.top
        )
    except Exception as exc:  # noqa: BLE001
        if args.live:
            print(
                f"    {ink.warn('✖ live pipeline call failed:')} "
                f"{type(exc).__name__}: {exc}"
            )
            _note(
                ink,
                "Likely a missing/rejected credential (OPENROUTER_API_KEY / "
                "SALESFORCE_API_KEY) or a TLS issue (NODE_EXTRA_CA_CERTS). Drop "
                "--live for the offline run.",
            )
            return 0
        raise

    _print_top_picks(ink, ranked, top_n=args.top)  # reused (STEP 6/6)
    _print_outro(ink, args.live)
    return 0


def main() -> None:
    """Parse args and run the interactive session."""
    parser = argparse.ArgumentParser(
        description=(
            "Interactive terminal walkthrough where you type answers to a "
            "member's AI preference sub-agent, then the orchestrator picks the "
            "group's top restaurants."
        )
    )
    parser.add_argument(
        "--live",
        action="store_true",
        help="Use the real providers (LLM extraction + OpenRouter embeddings + "
        "pgvector search + Claude re-rank). Needs a running DB + API keys. "
        "Default is a fully offline deterministic run.",
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
    parser.add_argument(
        "--member",
        default=None,
        help="Which persona you play: name/username (alice/bob/carol/dan) or "
        "1-based index. Default: alice (vegan).",
    )
    parser.add_argument(
        "--answers-file",
        default=None,
        help="Read answers (one per line) from a file instead of stdin — handy "
        "for repeatable runs.",
    )
    parser.add_argument(
        "--all-interactive",
        action="store_true",
        help="Type answers for every member, not just one.",
    )
    args = parser.parse_args()
    args.top = max(1, args.top)
    raise SystemExit(asyncio.run(_run(args)))


if __name__ == "__main__":
    main()
