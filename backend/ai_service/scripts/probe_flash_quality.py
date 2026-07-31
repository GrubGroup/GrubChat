"""Diagnostic: does the fast extractor keep taxonomy QUALITY on the real prompt?

``scripts/probe_fast_extractor.py`` found one model inside the ~700 ms LLM-leg
voice budget: ``google/gemini-2.5-flash-lite`` at ~526 ms p50, versus ~3.8 s for
the current strong model. But that probe used a stripped 74-token contract, and
speed is worthless if the extraction degrades — this feature exists so a user can
say "not feeling greasy food, want lighter" and get correct taxonomy tags.

So this validates the candidates on the REAL ``PREFERENCE_TURN_SYSTEM`` prompt
(full cuisine-group and style catalogs) across the free-form utterances the
feature must handle, and scores each on:

  * latency p50 vs the 700 ms budget,
  * JSON parseability (what ``analyze_turn`` requires), and
  * whether extraction lands the EXPECTED canonical tags — the actual quality bar.

Scoring is deliberately asymmetric. A miss on an expected tag is a real quality
failure. An extra tag is only flagged when it is not a plausible taxonomy
expansion, because the prompt intentionally asks the model to expand broad terms
("asian" -> its member cuisines), so a longer list is often correct behavior.

Run:
    cd backend/ai_service
    uv run python -m scripts.probe_flash_quality
"""

from __future__ import annotations

import asyncio
import json
import statistics
import time
from typing import Any

import httpx
from openai import AsyncOpenAI

from app.ai.agents.conversation_agent import _reconcile
from app.ai.llm.client import strip_json_fence
from app.ai.llm.prompts import build_preference_turn_messages
from app.core.config import settings
from app.schemas.ai import ExtractedSignals

REPS = 2
LLM_LEG_BUDGET_MS = 700.0

# The verbatim "arbitrary answers" cases from the feature goal, plus a
# correction turn (the hardest case — a stale tag must be dropped).
# `expect_any`: at least one of these tags must appear in the named field.
CASES: list[dict[str, Any]] = [
    {
        "message": "I'm not feeling greasy food and want lighter foods to eat",
        "field": "disliked_cuisines",
        "expect_any": ["fast_food", "fried_chicken", "burgers", "greasy", "barbecue"],
    },
    {
        "message": "I'm feeling like eating noodles but not sure what type",
        "field": "preferred_cuisines",
        "expect_any": ["ramen", "noodles", "pho", "thai", "chinese", "asian", "japanese", "vietnamese"],
    },
    {
        "message": "nothing too expensive, maybe twenty five bucks a head",
        "field": "budget_max",
        "expect_any": [25],
    },
    {
        "message": "actually I do like chinese, and drop the mexican",
        "field": "preferred_cuisines",
        "expect_any": ["chinese"],
        "prior": {"preferred_cuisines": ["mexican"], "disliked_cuisines": ["chinese"]},
        # The correction must also REMOVE these from the field.
        "expect_absent": ["mexican"],
    },
]

CANDIDATES = [
    ("openrouter", "google/gemini-2.5-flash-lite"),
    ("openrouter", "google/gemini-2.5-flash"),
    ("salesforce", "gemini-2.5-flash"),
    ("salesforce", "gpt-4o-mini"),
    # The incumbent, for a like-for-like quality reference.
    ("salesforce", "claude-sonnet-4-5-20250929"),
]


def _client_for(provider: str) -> tuple[AsyncOpenAI | None, str]:
    """Build a client for the named provider, or (None, reason)."""
    if provider == "salesforce":
        if not settings.salesforce_api_key:
            return None, "no SALESFORCE_API_KEY"
        return (
            AsyncOpenAI(
                api_key=settings.salesforce_api_key,
                base_url=settings.salesforce_base_url,
                http_client=httpx.AsyncClient(
                    verify=settings.node_extra_ca_certs or True
                ),
            ),
            "",
        )
    if not settings.openrouter_api_key:
        return None, "no OPENROUTER_API_KEY"
    return (
        AsyncOpenAI(
            api_key=settings.openrouter_api_key,
            base_url=settings.openrouter_base_url,
        ),
        "",
    )


async def _run_case(
    client: AsyncOpenAI, model: str, case: dict[str, Any], rep: int
) -> tuple[float, bool, bool, str]:
    """Run one case. Returns (elapsed_ms, json_ok, quality_ok, detail).

    Runs the model's raw output through the REAL ``_reconcile`` so the score
    reflects the tags that would actually be stored (taxonomy expansion and
    removals applied), not just what the model happened to emit.
    """
    prior = ExtractedSignals(**case.get("prior", {}))
    messages = build_preference_turn_messages(
        f"{case['message']} (ref {rep})",
        current_signals=prior.model_dump(),
        message_source="voice",
        is_host=False,
    )
    started = time.perf_counter()
    response = await client.chat.completions.create(
        model=model, messages=messages, temperature=0.2
    )
    elapsed = (time.perf_counter() - started) * 1000.0

    content = response.choices[0].message.content or ""
    try:
        parsed = json.loads(strip_json_fence(content))
        if not isinstance(parsed, dict):
            return elapsed, False, False, "not a JSON object"
    except (ValueError, TypeError):
        return elapsed, False, False, "unparseable"

    raw_signals = parsed.get("extracted_signals")
    if not isinstance(raw_signals, dict):
        raw_signals = parsed
    signals = _reconcile(prior, raw_signals)

    field = case["field"]
    value = getattr(signals, field)
    expect = case["expect_any"]

    if field == "budget_max":
        ok = value in expect
        return elapsed, True, ok, f"budget_max={value}"

    got = set(value or [])
    hit = got & set(expect)
    absent_violations = got & set(case.get("expect_absent", []))
    ok = bool(hit) and not absent_violations
    detail = f"hit={sorted(hit) or 'NONE'}"
    if absent_violations:
        detail += f" STALE={sorted(absent_violations)}"
    return elapsed, True, ok, detail


async def _score_model(provider: str, model: str) -> None:
    """Time + score one model across every case, then print one summary line."""
    client, reason = _client_for(provider)
    if client is None:
        print(f"  {provider}/{model:<32} SKIPPED ({reason})")
        return

    latencies: list[float] = []
    json_fails = 0
    quality_fails: list[str] = []
    details: list[str] = []

    for case in CASES:
        for rep in range(REPS):
            try:
                elapsed, json_ok, quality_ok, detail = await _run_case(
                    client, model, case, rep
                )
            except Exception as exc:
                print(
                    f"  {provider}/{model:<32} FAILED: "
                    f"{type(exc).__name__}: {str(exc)[:45]}"
                )
                return
            latencies.append(elapsed)
            if not json_ok:
                json_fails += 1
            elif not quality_ok:
                quality_fails.append(f"{case['field']}({detail})")
            if not rep:
                details.append(f"{case['field']}: {detail}")

    p50 = statistics.median(latencies)
    fits = "FITS" if p50 <= LLM_LEG_BUDGET_MS else f"{p50 / LLM_LEG_BUDGET_MS:.1f}x over"
    total = len(CASES) * REPS
    passed = total - json_fails - len(quality_fails)
    print(
        f"  {provider}/{model:<32} p50={p50:8.1f} ms  {fits:<10} "
        f"quality {passed}/{total}"
        + (f"  json_fail={json_fails}" if json_fails else "")
    )
    for line in details:
        print(f"      {line}")
    if quality_fails:
        print(f"      MISSES: {'; '.join(quality_fails[:4])}")


async def _run() -> int:
    print("=" * 78)
    print("  Fast extractor: does QUALITY hold on the real production prompt?")
    print("=" * 78)
    print(f"  cases={len(CASES)}  reps/case={REPS}  budget={LLM_LEG_BUDGET_MS:.0f} ms")
    print("  (raw model output is run through the REAL _reconcile before scoring)")
    print()
    for provider, model in CANDIDATES:
        await _score_model(provider, model)
        print()
    print("  Pick the fastest model that FITS with full quality. If none fits with")
    print("  clean quality, Stage 0 stays blocked and voice cannot hit the target.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_run()))
