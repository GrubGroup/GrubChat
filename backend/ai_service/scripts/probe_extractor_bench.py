"""Benchmark: pick the fastest extraction model that keeps parsing accurate.

Compares the requested candidate extraction models against the incumbent
``google/gemini-2.5-flash`` on the REAL production analyze turn — the same
``build_preference_turn_messages`` prompt and the same ``_reconcile`` merge that
``conversation_agent.analyze_turn`` runs — so the score reflects the tags that
would actually be stored, not a stripped toy contract.

Two things matter for this feature and both are measured PER MODALITY (text vs
voice), because the analyze turn carries a ``message_source`` and the two enter
the agent differently (typed text vs Deepgram STT transcript):

  * LATENCY — p50 / p95 of the LLM leg vs the ~700 ms real-time voice budget.
  * PARSING ACCURACY — JSON parseability (what analyze_turn requires) AND whether
    extraction lands the EXPECTED canonical taxonomy tags after ``_reconcile``.

Scoring is asymmetric, matching probe_flash_quality: a MISS on an expected tag is
a real failure; an EXTRA tag is fine (the prompt intentionally expands broad
terms like "asian" into member cuisines), except tags named in ``expect_absent``
(a correction must drop the stale value).

Run:
    cd backend/ai_service
    uv run python -m scripts.probe_extractor_bench
    # single model (used by the latency workflow, one model per agent):
    uv run python -m scripts.probe_extractor_bench --model google/gemini-2.5-flash
    uv run python -m scripts.probe_extractor_bench --model google/gemini-2.5-flash --json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import time
from typing import Any

from openai import AsyncOpenAI

from app.ai.agents.conversation_agent import _reconcile
from app.ai.llm.client import strip_json_fence
from app.ai.llm.prompts import build_preference_turn_messages
from app.core.config import settings
from app.schemas.ai import ExtractedSignals

# Reps per (case, modality). Higher than probe_flash_quality's 2 so p50/p95 are
# stable — the LLM gateway caches identical prompts, so each rep varies the
# message with a "(ref N)" suffix to defeat the cache (see the latency memory).
REPS = 4
LLM_LEG_BUDGET_MS = 700.0

# All candidates live on OpenRouter (the extraction provider). The incumbent is
# included last as the like-for-like reference.
CANDIDATES: list[str] = [
    "bytedance-seed/seed-2.0-mini",
    "poolside/laguna-s-2.1",
    "meta-llama/llama-4-maverick",
    "qwen/qwen-2.5-72b-instruct",
    "google/gemini-2.5-flash-lite",
    "google/gemini-2.5-flash",  # incumbent
]

# Free-form "arbitrary answers" the feature must handle (from the product goal),
# plus correction/removal turns (the hardest — a stale tag must be dropped).
#   field       — the ExtractedSignals field to score after _reconcile
#   expect_any  — at least one of these must land in that field
#   prior       — prior signals to reconcile against (for corrections)
#   expect_absent — tags that must NOT survive (stale value on a correction)
CASES: list[dict[str, Any]] = [
    {
        "message": "I'm not feeling greasy food and want lighter foods to eat",
        "field": "disliked_cuisines",
        "expect_any": ["fast_food", "fried_chicken", "burgers", "greasy", "barbecue", "bbq"],
    },
    {
        "message": "I'm feeling like eating noodles but not sure what type",
        "field": "preferred_cuisines",
        "expect_any": ["ramen", "noodles", "pho", "thai", "chinese", "asian", "japanese", "vietnamese", "udon"],
    },
    {
        "message": "something warm and comforting, maybe a nice soup or stew",
        "field": "preferred_cuisines",
        "expect_any": ["ramen", "pho", "soup", "vietnamese", "japanese", "korean", "noodles", "comfort_food", "hot_pot"],
    },
    {
        "message": "I could go for some spicy asian food tonight",
        "field": "preferred_cuisines",
        "expect_any": ["asian", "thai", "chinese", "korean", "japanese", "vietnamese", "indian", "szechuan", "sichuan"],
    },
    {
        "message": "nothing too expensive, maybe twenty five bucks a head",
        "field": "budget_max",
        "expect_any": [25],
    },
    {
        "message": "let's keep it under about forty dollars per person",
        "field": "budget_max",
        "expect_any": [40],
    },
    {
        "message": "somewhere around downtown san francisco would be great",
        "field": "location_label",
        "expect_substr": ["san francisco", "downtown"],
    },
    {
        "message": "actually I do like chinese, and drop the mexican",
        "field": "preferred_cuisines",
        "expect_any": ["chinese"],
        "prior": {"preferred_cuisines": ["mexican"], "disliked_cuisines": ["chinese"]},
        "expect_absent": ["mexican"],
    },
    {
        "message": "change my liked cuisine from italian to korean bbq",
        "field": "preferred_cuisines",
        "expect_any": ["korean", "korean_bbq", "bbq", "barbecue"],
        "prior": {"preferred_cuisines": ["italian"]},
        "expect_absent": ["italian"],
    },
]

MODALITIES = ["text", "voice"]


def _openrouter_client() -> AsyncOpenAI | None:
    if not settings.openrouter_api_key:
        return None
    return AsyncOpenAI(
        api_key=settings.openrouter_api_key,
        base_url=settings.openrouter_base_url,
    )


async def _run_case(
    client: AsyncOpenAI, model: str, case: dict[str, Any], modality: str, rep: int
) -> tuple[float, bool, bool, str]:
    """Run one (case, modality, rep). Returns (elapsed_ms, json_ok, quality_ok, detail)."""
    prior = ExtractedSignals(**case.get("prior", {}))
    messages = build_preference_turn_messages(
        f"{case['message']} (ref {rep})",
        current_signals=prior.model_dump(),
        message_source=modality,
        is_host=False,
        low_latency=settings.analyze_low_latency,
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

    if field == "budget_max":
        ok = value in case["expect_any"]
        return elapsed, True, ok, f"budget_max={value}"

    if "expect_substr" in case:
        text = (value or "").lower()
        ok = any(s in text for s in case["expect_substr"])
        return elapsed, True, ok, f"{field}={value!r}"

    got = set(value or [])
    hit = got & set(case["expect_any"])
    absent_violations = got & set(case.get("expect_absent", []))
    ok = bool(hit) and not absent_violations
    detail = f"hit={sorted(hit) or 'NONE'}"
    if absent_violations:
        detail += f" STALE={sorted(absent_violations)}"
    return elapsed, True, ok, detail


async def _score_model(client: AsyncOpenAI, model: str) -> dict[str, Any]:
    """Time + score one model across every case × modality × rep."""
    per_modality: dict[str, list[float]] = {m: [] for m in MODALITIES}
    all_latencies: list[float] = []
    json_fails = 0
    quality_fails: list[str] = []
    total = 0
    failed_reason: str | None = None

    for case in CASES:
        for modality in MODALITIES:
            for rep in range(REPS):
                total += 1
                try:
                    elapsed, json_ok, quality_ok, detail = await asyncio.wait_for(
                        _run_case(client, model, case, modality, rep), timeout=45
                    )
                except Exception as exc:
                    failed_reason = f"{type(exc).__name__}: {str(exc)[:60]}"
                    return {
                        "model": model,
                        "available": False,
                        "reason": failed_reason,
                    }
                per_modality[modality].append(elapsed)
                all_latencies.append(elapsed)
                if not json_ok:
                    json_fails += 1
                elif not quality_ok:
                    quality_fails.append(f"{modality}/{case['field']}({detail})")

    def stats(xs: list[float]) -> dict[str, float]:
        if not xs:
            return {"p50": float("nan"), "p95": float("nan"), "mean": float("nan")}
        xs_sorted = sorted(xs)
        p95_idx = min(len(xs_sorted) - 1, int(round(0.95 * (len(xs_sorted) - 1))))
        return {
            "p50": statistics.median(xs_sorted),
            "p95": xs_sorted[p95_idx],
            "mean": statistics.mean(xs_sorted),
        }

    overall = stats(all_latencies)
    passed = total - json_fails - len(quality_fails)
    return {
        "model": model,
        "available": True,
        "p50_ms": round(overall["p50"], 1),
        "p95_ms": round(overall["p95"], 1),
        "mean_ms": round(overall["mean"], 1),
        "text_p50_ms": round(stats(per_modality["text"])["p50"], 1),
        "voice_p50_ms": round(stats(per_modality["voice"])["p50"], 1),
        "fits_budget": overall["p50"] <= LLM_LEG_BUDGET_MS,
        "quality_passed": passed,
        "quality_total": total,
        "accuracy_pct": round(100.0 * passed / total, 1) if total else 0.0,
        "json_fails": json_fails,
        "quality_misses": quality_fails[:8],
    }


def _print_row(r: dict[str, Any]) -> None:
    model = r["model"]
    if not r.get("available"):
        print(f"  {model:<34} FAILED: {r.get('reason')}")
        return
    fits = "FITS" if r["fits_budget"] else f"{r['p50_ms'] / LLM_LEG_BUDGET_MS:.1f}x over"
    print(
        f"  {model:<34} p50={r['p50_ms']:8.1f}ms p95={r['p95_ms']:8.1f}ms "
        f"(text {r['text_p50_ms']:.0f} / voice {r['voice_p50_ms']:.0f})  "
        f"{fits:<9} acc {r['accuracy_pct']:.0f}% ({r['quality_passed']}/{r['quality_total']})"
        + (f"  json_fail={r['json_fails']}" if r["json_fails"] else "")
    )
    if r["quality_misses"]:
        print(f"      MISSES: {'; '.join(r['quality_misses'])}")


async def _run(models: list[str], as_json: bool) -> int:
    client = _openrouter_client()
    if client is None:
        print("No OPENROUTER_API_KEY — cannot benchmark extraction models.")
        return 1

    results = []
    for model in models:
        r = await _score_model(client, model)
        results.append(r)
        if not as_json:
            _print_row(r)

    if as_json:
        print(json.dumps(results, indent=2))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", action="append", help="model id (repeatable); default = all candidates")
    ap.add_argument("--json", action="store_true", help="emit JSON (for the workflow)")
    args = ap.parse_args()
    models = args.model or CANDIDATES
    if not args.json:
        print("=" * 96)
        print("  Extraction model benchmark — real prompt + _reconcile, per modality (text/voice)")
        print("=" * 96)
        print(f"  reps/(case,modality)={REPS}  cases={len(CASES)}  budget={LLM_LEG_BUDGET_MS:.0f}ms  provider=openrouter")
        print(f"  low_latency={settings.analyze_low_latency}")
        print()
    return asyncio.run(_run(models, args.json))


if __name__ == "__main__":
    raise SystemExit(main())
