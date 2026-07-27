"""Stage 0 latency measurement for the conversational analyze turn (voice budget).

Answers one question before any voice work starts: **can the existing text
``/analyze`` turn fit inside a real-time voice budget?** The published cascaded
voice budget is ~1293 ms voice-to-voice, of which the LLM leg gets ~700 ms
(STT+endpointing ~300 ms, TTS ~120 ms, network ~223 ms). If the LLM leg alone
blows 700 ms, the STT/TTS vendor choice is moot and this is where the work goes.

WHAT IS MEASURED, AND WHY THIS SHAPE
------------------------------------
The dominant cost is the single blocking ``chat_completion`` call inside
``conversation_agent.analyze_turn``. This script drives the REAL agent (real
prompt, real reconcile, real taxonomy expansion) against the REAL provider
selected by ``LLM_PROVIDER``, with **no DB and no gateway**, so the number is a
clean floor for the LLM leg — every other hop only adds to it.

It walks a realistic 4-turn slot-filling conversation (likes -> dislikes ->
budget -> location), because prompt size grows with each turn as history and
reconciled signals accumulate. Measuring only turn 1 would flatter the result;
the LAST turn is the worst case and is reported separately.

THE TTFT/TOTAL DISTINCTION (the load-bearing finding)
-----------------------------------------------------
A streaming text agent can start speaking at first token. **This one cannot.**
``analyze_turn`` must receive a COMPLETE JSON object before it can
``json.loads`` it and read ``agent_reply`` — a partial JSON object is not
speakable. So for this architecture the figure that matters is TOTAL completion
time, not time-to-first-token. ``--stream`` measures both against the raw
provider client to quantify exactly what restructuring for streaming could buy
(and whether the provider even supports it).

CACHE DEFEAT (do not remove — the reason this file exists in this shape)
-----------------------------------------------------------------------
``scripts/probe_llm_cache.py`` proved the active Salesforce/Claude gateway
returns cached responses for a repeated identical prompt: repeats came back
~10x faster (mean 167 ms) than nonce-varied prompts (mean 1725 ms). A harness
that replays one fixed script therefore measures the CACHE on every rep after
the first, and reports a p50 that production would never see.

So every rep here uses a DIFFERENT paraphrase set (``TURN_VARIANTS``), and a
per-rep nonce is appended to the location turn. Same slot-filling semantics and
comparable token counts, distinct prompt bytes. If you add reps beyond the
variant count, the script says so rather than silently recycling a cached prompt.

Run:
    cd backend/ai_service
    uv run python -m scripts.measure_analyze_latency            # 3 reps, agent path
    uv run python -m scripts.measure_analyze_latency -n 5       # more reps
    uv run python -m scripts.measure_analyze_latency --stream   # + TTFT probe
"""

from __future__ import annotations

import argparse
import asyncio
import statistics
import time
from typing import Any

from app.ai.agents.conversation_agent import analyze_turn
from app.ai.llm.client import get_llm_client
from app.ai.llm.prompts import build_preference_turn_messages
from app.core.config import settings
from app.schemas.ai import ConversationTurn, ExtractedSignals

# The LLM leg's share of the ~1293 ms published cascaded voice-to-voice budget.
LLM_LEG_BUDGET_MS = 700.0
VOICE_TO_VOICE_BUDGET_MS = 1293.0

# One realistic slot-filling conversation per REP, in ask-order (likes ->
# dislikes -> budget -> location). Deliberately loose, free-form wording — the
# "arbitrary answers" case the feature exists to handle — so the measured
# prompt/parse work matches production rather than a toy input.
#
# Each rep uses a DIFFERENT variant so no prompt repeats across reps (see the
# CACHE DEFEAT note above). Variants are paraphrases of the same four slots with
# comparable length, so per-turn-index samples stay comparable across reps.
TURN_VARIANTS: list[list[str]] = [
    [
        "i'm not feeling greasy food, want something lighter to eat",
        "i'm feeling like noodles but not sure what type",
        "nothing too expensive, maybe twenty five bucks a head",
        "somewhere near the mission would be easier for me",
    ],
    [
        "no heavy fried stuff tonight please, something fresher",
        "maybe a soup or broth kind of dish, open on the specifics",
        "trying to keep it under about thirty dollars each",
        "anywhere close to hayes valley works better for me",
    ],
    [
        "i'd rather skip anything deep fried or super rich",
        "thinking warm noodle bowls, whatever style is good",
        "let's say twenty bucks per person as a ceiling",
        "north beach is a lot more convenient on my end",
    ],
    [
        "please nothing oily, i want a cleaner lighter meal",
        "some kind of ramen or pho maybe, not picky which",
        "budget wise around twenty eight a head is fine",
        "if we can stay near soma that's easiest for me",
    ],
    [
        "avoid the greasy end of the menu, lighter is better",
        "craving noodles of some sort, undecided on the kind",
        "keeping spend to roughly thirty five per person",
        "the marina side would save me a lot of travel",
    ],
]


def _pct(values: list[float], p: float) -> float:
    """Nearest-rank percentile (no interpolation) — honest for tiny n."""
    if not values:
        return float("nan")
    ordered = sorted(values)
    idx = min(len(ordered) - 1, max(0, int(round(p / 100.0 * len(ordered) + 0.5)) - 1))
    return ordered[idx]


def _fmt_ms(value: float) -> str:
    return f"{value:8.1f} ms"


def _summarize(label: str, samples: list[float], budget: float | None = None) -> None:
    """Print p50/p95/min/max for one sample set, flagged against a budget."""
    if not samples:
        print(f"  {label:<34} (no samples)")
        return
    p50, p95 = _pct(samples, 50), _pct(samples, 95)
    verdict = ""
    if budget is not None:
        verdict = "  OVER BUDGET" if p50 > budget else "  within budget"
    print(
        f"  {label:<34} n={len(samples):<3} "
        f"p50={_fmt_ms(p50)}  p95={_fmt_ms(p95)}  "
        f"min={_fmt_ms(min(samples))}  max={_fmt_ms(max(samples))}{verdict}"
    )


def _turns_for_rep(rep: int) -> list[str]:
    """The four messages for one rep — a distinct variant, plus a nonce.

    Cycling variants keeps prompts unique across reps so the gateway cache
    cannot serve a repeat (see the CACHE DEFEAT note). The nonce on the last
    turn guarantees uniqueness even if reps exceed the variant count, and rides
    on the location turn where a stray token cannot change slot semantics.
    """
    variant = list(TURN_VARIANTS[rep % len(TURN_VARIANTS)])
    if rep >= len(TURN_VARIANTS):
        variant[-1] = f"{variant[-1]} (ref {rep})"
    return variant


async def _measure_agent_turns(reps: int) -> dict[str, Any]:
    """Time the REAL analyze_turn across a growing 4-turn conversation, reps times.

    Each rep replays a full conversation from empty signals so turn N always
    carries N-1 turns of history — the prompt growth production would see.
    Per-turn-index samples are kept separately so the worst (last) turn is
    visible rather than averaged away. Each rep uses a distinct wording variant
    so no sample can be served from the provider's response cache.
    """
    turn_count = len(TURN_VARIANTS[0])
    per_turn: dict[int, list[float]] = {i: [] for i in range(turn_count)}
    all_samples: list[float] = []
    degraded_count = 0
    last_reply = ""
    prompt_chars: dict[int, int] = {}

    for rep in range(reps):
        signals = ExtractedSignals()
        history: list[ConversationTurn] = []

        for idx, message in enumerate(_turns_for_rep(rep)):
            # Record the real prompt size for this turn index (once) so the
            # report can show growth without re-deriving it.
            if rep == 0:
                built = build_preference_turn_messages(
                    message,
                    conversation_history=[t.model_dump() for t in history],
                    current_signals=signals.model_dump(),
                    is_host=False,
                )
                prompt_chars[idx] = sum(len(m["content"]) for m in built)

            started = time.perf_counter()
            result = await analyze_turn(
                message,
                current_signals=signals,
                message_source="voice",
                conversation_history=history,
                is_host=False,
            )
            elapsed_ms = (time.perf_counter() - started) * 1000.0

            per_turn[idx].append(elapsed_ms)
            all_samples.append(elapsed_ms)
            if result.degraded:
                degraded_count += 1

            signals = result.signals
            history += [
                ConversationTurn(role="user", content=message),
                ConversationTurn(role="assistant", content=result.agent_reply),
            ]
            last_reply = result.agent_reply

        print(f"    rep {rep + 1}/{reps} done", flush=True)

    return {
        "per_turn": per_turn,
        "all": all_samples,
        "degraded": degraded_count,
        "last_reply": last_reply,
        "prompt_chars": prompt_chars,
    }


async def _measure_stream(reps: int) -> dict[str, list[float]]:
    """Probe TTFT vs total on the raw provider client with stream=True.

    Bypasses analyze_turn deliberately: the point is to learn what the PROVIDER
    could deliver if the agent were restructured to stream, and whether this
    provider supports streaming at all. Uses a real turn-1 prompt so token
    counts are representative, varied per rep to defeat the response cache.
    """
    ttft: list[float] = []
    total: list[float] = []

    for rep in range(reps):
        messages = build_preference_turn_messages(
            _turns_for_rep(rep)[0],
            current_signals=ExtractedSignals().model_dump(),
            message_source="voice",
            is_host=False,
        )
        started = time.perf_counter()
        first_at: float | None = None
        stream = await get_llm_client().chat.completions.create(
            model=settings.active_llm_model,
            messages=messages,
            temperature=0.2,
            stream=True,
        )
        async for chunk in stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            if first_at is None and getattr(delta, "content", None):
                first_at = time.perf_counter()
        ended = time.perf_counter()

        if first_at is not None:
            ttft.append((first_at - started) * 1000.0)
        total.append((ended - started) * 1000.0)

    return {"ttft": ttft, "total": total}


async def _run(args: argparse.Namespace) -> int:
    print("=" * 78)
    print("  Stage 0 — /analyze LLM-leg latency (voice budget check)")
    print("=" * 78)
    turn_count = len(TURN_VARIANTS[0])
    print(f"  provider          : {settings.llm_provider}")
    print(f"  model             : {settings.active_llm_model}")
    print(f"  reps              : {args.reps}   turns/rep: {turn_count}")
    print(f"  LLM leg budget    : {LLM_LEG_BUDGET_MS:.0f} ms")
    print(f"  voice-to-voice    : {VOICE_TO_VOICE_BUDGET_MS:.0f} ms (reference)")
    print("  NOTE: no DB, no gateway — this is the FLOOR for the LLM leg.")
    print("  NOTE: prompts vary per rep to defeat the gateway response cache")
    print("        (see scripts/probe_llm_cache.py — repeats were ~10x faster).")
    print()

    provider = settings.llm_provider.strip().lower()
    key = settings.salesforce_api_key if provider == "salesforce" else settings.openrouter_api_key
    if not key:
        print(f"  ABORT: no API key for provider '{provider}'. Nothing measured.")
        return 1

    print("  Measuring real analyze_turn (LLM parse + reconcile + taxonomy)...")
    agent = await _measure_agent_turns(args.reps)
    print()

    print("  --- per-turn (prompt grows with history) ---")
    for idx in range(turn_count):
        chars = agent["prompt_chars"].get(idx)
        approx_tok = f"~{chars // 4} tok" if chars else "?"
        _summarize(
            f"turn {idx + 1} ({approx_tok})",
            agent["per_turn"][idx],
            budget=LLM_LEG_BUDGET_MS,
        )
    print()
    print("  --- aggregate ---")
    _summarize("analyze_turn TOTAL (all turns)", agent["all"], budget=LLM_LEG_BUDGET_MS)
    worst_idx = turn_count - 1
    _summarize(
        f"analyze_turn worst turn (#{worst_idx + 1})",
        agent["per_turn"][worst_idx],
        budget=LLM_LEG_BUDGET_MS,
    )
    if agent["degraded"]:
        print(
            f"  WARNING: {agent['degraded']} turn(s) DEGRADED (LLM output unusable). "
            "Those samples measure the failure path, not a healthy parse."
        )
    print()

    if args.stream:
        print("  Probing provider streaming (TTFT vs total, turn-1 prompt)...")
        try:
            stream_res = await _measure_stream(args.reps)
        except Exception as exc:  # provider may not support streaming at all
            print(f"    streaming probe FAILED: {type(exc).__name__}: {exc}")
            print("    (treat as: streaming not available on this provider path)")
        else:
            _summarize("stream TTFT (first token)", stream_res["ttft"], budget=LLM_LEG_BUDGET_MS)
            _summarize("stream TOTAL (last token)", stream_res["total"], budget=LLM_LEG_BUDGET_MS)
            print(
                "    NOTE: analyze_turn cannot use TTFT — it must json.loads a\n"
                "    COMPLETE object before agent_reply exists. TOTAL is the\n"
                "    figure that binds today; TTFT is the ceiling a redesign could reach."
            )
        print()

    p50 = _pct(agent["all"], 50)
    worst_p50 = _pct(agent["per_turn"][worst_idx], 50)
    print("=" * 78)
    print("  VERDICT")
    print("=" * 78)
    over = worst_p50 > LLM_LEG_BUDGET_MS
    print(f"  worst-turn p50 = {worst_p50:.0f} ms vs {LLM_LEG_BUDGET_MS:.0f} ms budget")
    if over:
        factor = worst_p50 / LLM_LEG_BUDGET_MS
        print(f"  OVER BUDGET by {factor:.1f}x. Projected voice-to-voice, adding")
        print(f"  ~300 ms STT + ~120 ms TTS + ~223 ms network = ~{worst_p50 + 643:.0f} ms.")
        print("  The LLM leg — not the STT/TTS vendor — is the binding constraint.")
    else:
        print("  Within the LLM-leg budget. STT/TTS vendor choice can proceed.")
    print(f"  (all-turn p50 = {p50:.0f} ms)")
    print()
    print(f"  last agent_reply: {agent['last_reply'][:150]}")
    return 0


def main() -> None:
    """Parse args and run the latency measurement."""
    parser = argparse.ArgumentParser(
        description=(
            "Measure the LLM leg of the conversational /analyze turn against the "
            "~700 ms voice budget. No DB, no gateway — a clean floor."
        )
    )
    parser.add_argument(
        "-n",
        "--reps",
        type=int,
        default=3,
        help="How many times to replay the 4-turn conversation (default 3).",
    )
    parser.add_argument(
        "--stream",
        action="store_true",
        help="Also probe provider TTFT vs total with stream=True.",
    )
    raise SystemExit(asyncio.run(_run(parser.parse_args())))


if __name__ == "__main__":
    main()
