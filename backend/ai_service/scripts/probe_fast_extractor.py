"""Diagnostic: would a FASTER extraction model bring the analyze turn into budget?

Stage 0 chain of findings:
  1. The production turn runs ~3.8 s p50 vs a ~700 ms LLM-leg budget (5.4x over).
  2. It is OUTPUT-bound: ~13 ms per output token; input size is irrelevant.
  3. Even a zero-prose, delta-only output (69 tokens) still costs ~2.1 s (3.0x
     over), so trimming the output cannot close the gap on the current model.

That leaves the model tier — and there is an obvious suspect. ``backend/CLAUDE.md``
states the intended routing as "cheap model for extraction, strong model for
ranking/justification", but ``conversation_agent.analyze_turn`` calls
``chat_completion(messages, temperature=0.2)`` with NO model override, so it
inherits ``settings.active_llm_model`` — the STRONG model (claude-sonnet-4-5 on
the Salesforce path). The extraction turn is running on the ranking model,
contrary to the documented rule.

This probe asks whether honoring that rule is enough: it lists what each provider
actually offers, then times candidate fast models on the delta-only extraction
task, reporting p50 against the 700 ms budget and whether the output still parses
as the JSON contract requires. Speed is worthless here if the tags come back
unparseable, so both are checked.

Run:
    cd backend/ai_service
    uv run python -m scripts.probe_fast_extractor
"""

from __future__ import annotations

import asyncio
import json
import statistics
import time
from typing import Any

import httpx
from openai import AsyncOpenAI

from app.ai.llm.client import strip_json_fence
from app.core.config import settings

REPS = 3
LLM_LEG_BUDGET_MS = 700.0
MESSAGE = "i'm not feeling greasy food, want something lighter to eat"

# Candidate cheap/fast extraction models per provider. Unavailable IDs simply
# report FAILED — the probe is a survey, not an assertion that these exist.
SALESFORCE_CANDIDATES = [
    "claude-haiku-4-5-20251001",
    "claude-3-5-haiku-20241022",
    "gpt-4o-mini",
]
OPENROUTER_CANDIDATES = [
    "openai/gpt-4o-mini",
    "google/gemini-2.5-flash-lite",
    "anthropic/claude-haiku-4.5",
]

# The minimal extraction contract from probe_minimal_output's winning shape:
# changed fields only, no prose. The server authors the spoken question from
# missing_signals (which it already does today).
EXTRACT_SYSTEM = (
    "Extract dining preferences from the user's free-form message. Return STRICT "
    "JSON only, with exactly two keys: "
    '"extracted_signals" — ONLY the fields that changed this turn, from '
    "(preferred_cuisines, disliked_cuisines, dietary_restrictions as lowercase "
    "underscore tag lists; budget_min, budget_max as ints; location_mode as "
    'named|realtime|unset; location_label as a string) — and "missing_signals", a '
    "list drawn from (preferred_cuisines, disliked_cuisines, budget, location). "
    "Emit no prose and no code fences."
)


async def _list_models(client: AsyncOpenAI, label: str) -> None:
    """Best-effort model listing — many gateways don't expose /v1/models."""
    try:
        page = await client.models.list()
        ids = sorted(m.id for m in page.data)
    except Exception as exc:
        print(f"  {label}: /v1/models unavailable ({type(exc).__name__})")
        return
    # Surface only plausibly-fast tiers; the full list can be thousands long.
    fast = [i for i in ids if any(k in i.lower() for k in ("haiku", "mini", "flash", "lite", "small"))]
    print(f"  {label}: {len(ids)} models; fast-tier candidates:")
    for model_id in fast[:12]:
        print(f"      {model_id}")
    if not fast:
        print(f"      (none matched haiku/mini/flash/lite; first few: {ids[:5]})")


async def _time_model(client: AsyncOpenAI, model: str) -> None:
    """Time REPS extraction calls on one model; validate the JSON contract."""
    latencies: list[float] = []
    out_tokens: list[int] = []
    parse_failures = 0
    sample = ""

    for rep in range(REPS):
        messages = [
            {"role": "system", "content": EXTRACT_SYSTEM},
            {"role": "user", "content": f"{MESSAGE} (ref {rep})"},
        ]
        started = time.perf_counter()
        try:
            response = await client.chat.completions.create(
                model=model, messages=messages, temperature=0.2
            )
        except Exception as exc:
            print(f"    {model:<34} FAILED: {type(exc).__name__}: {str(exc)[:50]}")
            return
        latencies.append((time.perf_counter() - started) * 1000.0)
        content = response.choices[0].message.content or ""
        usage = getattr(response, "usage", None)
        if usage and getattr(usage, "completion_tokens", None):
            out_tokens.append(usage.completion_tokens)
        if not rep:
            sample = content.replace("\n", " ")[:110]
        try:
            parsed = json.loads(strip_json_fence(content))
            if not isinstance(parsed, dict) or "extracted_signals" not in parsed:
                parse_failures += 1
        except (ValueError, TypeError):
            parse_failures += 1

    p50 = statistics.median(latencies)
    fits = "FITS BUDGET" if p50 <= LLM_LEG_BUDGET_MS else f"{p50 / LLM_LEG_BUDGET_MS:.1f}x over"
    warn = f"  [{parse_failures}/{REPS} BAD JSON]" if parse_failures else ""
    mean_out = statistics.mean(out_tokens) if out_tokens else float("nan")
    print(f"    {model:<34} p50={p50:8.1f} ms  out={mean_out:4.0f} tok  {fits}{warn}")
    if sample:
        print(f"      -> {sample}")


async def _run() -> int:
    print("=" * 78)
    print("  Would a FAST extraction model fit the 700 ms LLM-leg budget?")
    print("=" * 78)
    print(f"  reps/model={REPS}  budget={LLM_LEG_BUDGET_MS:.0f} ms")
    print("  baseline: strong model, delta-only output = ~2094 ms (3.0x over)")
    print()

    sf_client = None
    if settings.salesforce_api_key:
        sf_client = AsyncOpenAI(
            api_key=settings.salesforce_api_key,
            base_url=settings.salesforce_base_url,
            http_client=httpx.AsyncClient(verify=settings.node_extra_ca_certs or True),
        )
    or_client = None
    if settings.openrouter_api_key:
        or_client = AsyncOpenAI(
            api_key=settings.openrouter_api_key,
            base_url=settings.openrouter_base_url,
        )

    print("  --- what's available ---")
    if sf_client:
        await _list_models(sf_client, "salesforce")
    if or_client:
        await _list_models(or_client, "openrouter")
    print()

    if sf_client:
        print("  --- salesforce candidates (extraction task) ---")
        for model in SALESFORCE_CANDIDATES:
            await _time_model(sf_client, model)
        print()
    if or_client:
        print("  --- openrouter candidates (extraction task) ---")
        for model in OPENROUTER_CANDIDATES:
            await _time_model(or_client, model)
        print()

    print("  A model that FITS BUDGET with clean JSON is the Stage 0 fix:")
    print("  route extraction to it (honoring the documented cheap-model rule)")
    print("  and keep the strong model for ranking/justification.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_run()))
