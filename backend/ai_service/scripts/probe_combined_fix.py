"""Diagnostic: fast model + delta-only output — does the COMBINATION fit budget?

The final Stage 0 question. Established so far:

  * production turn: ~3.8 s p50, 5.4x the ~700 ms LLM-leg budget;
  * the turn is OUTPUT-bound at ~13 ms/token (input size is irrelevant);
  * delta-only output on the strong model: ~2.1 s (3.0x over) — not enough alone;
  * ``gemini-2.5-flash`` on the full prompt: ~1.2 s (1.7x over) at 8/8 quality;
  * ``gemini-2.5-flash-lite``: ~0.9 s but 6/8 — it misses the "greasy food" case.

Neither lever alone closes the gap. This tests them TOGETHER — the fast model AND
the trimmed output contract — which is the actual proposed fix, and the only
remaining configuration that could bring the existing text agent inside a
sub-1.3 s voice-to-voice target without changing the architecture.

Quality is scored exactly as in ``probe_flash_quality.py`` (real ``_reconcile``,
same free-form cases including the correction turn), because a fast turn that
mis-parses "lighter food" is not a fix.

Run:
    cd backend/ai_service
    uv run python -m scripts.probe_combined_fix
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
from app.ai.llm.prompts import PREFERENCE_TURN_SYSTEM
from app.core.config import settings
from app.schemas.ai import ExtractedSignals

REPS = 3
LLM_LEG_BUDGET_MS = 700.0

# The delta-only override that won in probe_minimal_output: emit changed fields
# only and NO prose. The server already authors the next question from
# missing_signals, so dropping agent_reply loses nothing the user hears.
DELTA_ONLY = (
    "\n\n=== OUTPUT OVERRIDE (supersedes the JSON shape above) ===\n"
    "Return ONLY the signal fields whose value CHANGED this turn — omit every "
    "unchanged field. Do not echo the full signal set. Emit exactly two keys: "
    '"extracted_signals" (changed fields only) and "missing_signals". Emit NO '
    "agent_reply, no prose, no code fences."
)

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
        "expect_absent": ["mexican"],
    },
]

CANDIDATES = [
    ("openrouter", "google/gemini-2.5-flash"),
    ("openrouter", "google/gemini-2.5-flash-lite"),
]


def _client_for(provider: str) -> AsyncOpenAI | None:
    if provider == "salesforce":
        if not settings.salesforce_api_key:
            return None
        return AsyncOpenAI(
            api_key=settings.salesforce_api_key,
            base_url=settings.salesforce_base_url,
            http_client=httpx.AsyncClient(verify=settings.node_extra_ca_certs or True),
        )
    if not settings.openrouter_api_key:
        return None
    return AsyncOpenAI(
        api_key=settings.openrouter_api_key,
        base_url=settings.openrouter_base_url,
    )


async def _run_case(
    client: AsyncOpenAI, model: str, case: dict[str, Any], rep: int
) -> tuple[float, bool, bool, str, int]:
    """One case. Returns (ms, json_ok, quality_ok, detail, out_tokens)."""
    prior = ExtractedSignals(**case.get("prior", {}))
    messages = [
        {"role": "system", "content": PREFERENCE_TURN_SYSTEM + DELTA_ONLY},
        {
            "role": "user",
            "content": (
                "MESSAGE_SOURCE: voice\nUSER_ROLE: MEMBER\n"
                "CURRENT_SIGNALS (captured so far — reconcile against this):\n"
                f"{json.dumps(prior.model_dump())}\n\n"
                f"NEW USER_MESSAGE:\n{case['message']} (ref {rep})\n\n"
                "Return the updated strict JSON object now."
            ),
        },
    ]
    started = time.perf_counter()
    response = await client.chat.completions.create(
        model=model, messages=messages, temperature=0.2
    )
    elapsed = (time.perf_counter() - started) * 1000.0

    content = response.choices[0].message.content or ""
    usage = getattr(response, "usage", None)
    out_tok = (getattr(usage, "completion_tokens", 0) or 0) if usage else 0

    try:
        parsed = json.loads(strip_json_fence(content))
        if not isinstance(parsed, dict):
            return elapsed, False, False, "not an object", out_tok
    except (ValueError, TypeError):
        return elapsed, False, False, "unparseable", out_tok

    raw_signals = parsed.get("extracted_signals")
    if not isinstance(raw_signals, dict):
        raw_signals = parsed
    signals = _reconcile(prior, raw_signals)

    field = case["field"]
    value = getattr(signals, field)
    if field == "budget_max":
        return elapsed, True, value in case["expect_any"], f"budget_max={value}", out_tok

    got = set(value or [])
    hit = got & set(case["expect_any"])
    stale = got & set(case.get("expect_absent", []))
    detail = f"hit={sorted(hit) or 'NONE'}"
    if stale:
        detail += f" STALE={sorted(stale)}"
    return elapsed, True, bool(hit) and not stale, detail, out_tok


async def _score(provider: str, model: str) -> None:
    client = _client_for(provider)
    if client is None:
        print(f"  {provider}/{model}: SKIPPED (no key)")
        return

    latencies: list[float] = []
    out_tokens: list[int] = []
    json_fails = 0
    misses: list[str] = []
    first_detail: list[str] = []

    for case in CASES:
        for rep in range(REPS):
            try:
                ms, json_ok, quality_ok, detail, out_tok = await _run_case(
                    client, model, case, rep
                )
            except Exception as exc:
                print(f"  {model}: FAILED {type(exc).__name__}: {str(exc)[:50]}")
                return
            latencies.append(ms)
            out_tokens.append(out_tok)
            if not json_ok:
                json_fails += 1
            elif not quality_ok:
                misses.append(f"{case['field']}({detail})")
            if not rep:
                first_detail.append(f"{case['field']}: {detail}")

    p50 = statistics.median(latencies)
    p95 = sorted(latencies)[min(len(latencies) - 1, int(0.95 * len(latencies)))]
    total = len(CASES) * REPS
    passed = total - json_fails - len(misses)
    fits = "FITS BUDGET" if p50 <= LLM_LEG_BUDGET_MS else f"{p50 / LLM_LEG_BUDGET_MS:.1f}x over"

    print(f"  {provider}/{model}")
    print(
        f"    p50={p50:7.1f} ms   p95={p95:7.1f} ms   "
        f"out={statistics.mean(out_tokens):4.0f} tok   {fits}"
    )
    print(f"    quality {passed}/{total}" + (f"   json_fail={json_fails}" if json_fails else ""))
    for line in first_detail:
        print(f"      {line}")
    if misses:
        print(f"      MISSES: {'; '.join(misses[:4])}")
    # Project the full voice loop with the published cascade budget components.
    print(
        f"    projected voice-to-voice: ~{p50 + 300 + 120 + 223:.0f} ms "
        "(+300 STT +120 TTS +223 net)"
    )


async def _run() -> int:
    print("=" * 78)
    print("  COMBINED FIX: fast model + delta-only output")
    print("=" * 78)
    print(f"  cases={len(CASES)} reps/case={REPS} budget={LLM_LEG_BUDGET_MS:.0f} ms")
    print("  reference: strong model + full output = 3762 ms (5.4x over)")
    print()
    for provider, model in CANDIDATES:
        await _score(provider, model)
        print()
    print("  A row that FITS with full quality is the Stage 0 unblock.")
    print("  Its projected voice-to-voice vs the ~1293 ms target is the number")
    print("  that decides whether the cascade design is viable as specified.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_run()))
