"""Diagnostic: is the analyze turn INPUT-bound or OUTPUT-bound?

Stage 0 measured the production conversational turn at ~3.9 s p50 (n=20) against
a ~700 ms voice budget. Follow-up probes then showed a *trivial* completion on
the same provider costs only ~400-600 ms, which rules out a large fixed
per-call floor and points at the request itself. Two candidates remain:

  * INPUT-bound — the ~2.4k-token system prompt (dominated by the taxonomy
    group/style catalogs interpolated into ``PREFERENCE_TURN_SYSTEM``).
  * OUTPUT-bound — the ~183 completion tokens. The turn returns the FULL
    reconciled signal set (every field, every expanded taxonomy tag) plus a
    prose ``agent_reply``, every single turn.

These imply opposite fixes, so this runs a 2x2: {full, slim} prompt x {capped,
uncapped} output, at n=5 with nonce-varied prompts, and reports an implied
per-output-token cost. Whichever factor moves the mean is the lever.

Run:
    cd backend/ai_service
    uv run python -m scripts.probe_token_cost
"""

from __future__ import annotations

import asyncio
import statistics
import time
from typing import Any

import httpx
from openai import AsyncOpenAI

from app.ai.llm.prompts import build_preference_turn_messages
from app.core.config import settings
from app.schemas.ai import ExtractedSignals

REPS = 5
MESSAGE = "i'm not feeling greasy food, want something lighter to eat"

# A slim system prompt: same extraction task, taxonomy catalogs REMOVED. This is
# the "what if we stopped shipping the catalogs every turn" counterfactual.
SLIM_SYSTEM = (
    "You are a diner's food-preference agent. From the user's free-form message, "
    "return STRICT JSON only with keys: "
    '"extracted_signals" (preferred_cuisines, disliked_cuisines, '
    "dietary_restrictions as lowercase underscore tag lists; budget_min, "
    'budget_max as ints or null; location_mode, location_label), '
    '"agent_reply" (one or two short sentences confirming what you captured then '
    'asking the next missing question), "missing_signals" (list from '
    "preferred_cuisines, disliked_cuisines, budget, location). No prose, no fences."
)


def _mean(values: list[float]) -> float:
    return statistics.mean(values) if values else float("nan")


def _full(rep: int) -> list[dict[str, Any]]:
    """The real production prompt, nonce-varied."""
    return build_preference_turn_messages(
        f"{MESSAGE} (ref {rep})",
        current_signals=ExtractedSignals().model_dump(),
        message_source="voice",
        is_host=False,
    )


def _slim(rep: int) -> list[dict[str, Any]]:
    """Same task, catalogs stripped — isolates input-token cost."""
    return [
        {"role": "system", "content": SLIM_SYSTEM},
        {"role": "user", "content": f"MESSAGE_SOURCE: voice\n{MESSAGE} (ref {rep})"},
    ]


async def _cell(
    client: AsyncOpenAI,
    model: str,
    label: str,
    build: Any,
    max_tokens: int | None,
) -> dict[str, float]:
    """Run one 2x2 cell REPS times; print and return mean latency + mean tokens."""
    latencies: list[float] = []
    in_tokens: list[int] = []
    out_tokens: list[int] = []

    for rep in range(REPS):
        kwargs: dict[str, Any] = {
            "model": model,
            "messages": build(rep),
            "temperature": 0.2,
        }
        if max_tokens is not None:
            kwargs["max_tokens"] = max_tokens
        started = time.perf_counter()
        try:
            response = await client.chat.completions.create(**kwargs)
        except Exception as exc:
            print(f"  {label:<38} FAILED: {type(exc).__name__}: {str(exc)[:70]}")
            return {}
        latencies.append((time.perf_counter() - started) * 1000.0)
        usage = getattr(response, "usage", None)
        if usage:
            if getattr(usage, "prompt_tokens", None):
                in_tokens.append(usage.prompt_tokens)
            if getattr(usage, "completion_tokens", None):
                out_tokens.append(usage.completion_tokens)

    mean_latency = _mean(latencies)
    mean_out = _mean(out_tokens) if out_tokens else float("nan")
    mean_in = _mean(in_tokens) if in_tokens else float("nan")
    print(
        f"  {label:<38} mean={mean_latency:8.1f} ms  "
        f"p50={statistics.median(latencies):7.1f}  "
        f"in={mean_in:6.0f}  out={mean_out:5.0f}"
    )
    return {"latency": mean_latency, "in": mean_in, "out": mean_out}


async def _run() -> int:
    print("=" * 78)
    print("  Analyze turn: INPUT-bound or OUTPUT-bound?")
    print("=" * 78)
    provider = settings.llm_provider.strip().lower()
    if provider == "salesforce":
        if not settings.salesforce_api_key:
            print("  ABORT: SALESFORCE_API_KEY empty.")
            return 1
        client = AsyncOpenAI(
            api_key=settings.salesforce_api_key,
            base_url=settings.salesforce_base_url,
            http_client=httpx.AsyncClient(verify=settings.node_extra_ca_certs or True),
        )
        model = settings.salesforce_llm_model
    else:
        if not settings.openrouter_api_key:
            print("  ABORT: OPENROUTER_API_KEY empty.")
            return 1
        client = AsyncOpenAI(
            api_key=settings.openrouter_api_key,
            base_url=settings.openrouter_base_url,
        )
        model = settings.openrouter_llm_model

    print(f"  provider={provider}  model={model}  reps/cell={REPS} (nonce-varied)")
    print()

    cells: dict[str, dict[str, float]] = {}
    cells["full_uncapped"] = await _cell(
        client, model, "FULL prompt, uncapped (PRODUCTION)", _full, None
    )
    cells["full_capped"] = await _cell(
        client, model, "FULL prompt, max_tokens=64", _full, 64
    )
    cells["slim_uncapped"] = await _cell(
        client, model, "SLIM prompt, uncapped", _slim, None
    )
    cells["slim_capped"] = await _cell(
        client, model, "SLIM prompt, max_tokens=64", _slim, 64
    )
    print()

    prod = cells.get("full_uncapped") or {}
    slim_unc = cells.get("slim_uncapped") or {}
    full_cap = cells.get("full_capped") or {}
    if not prod:
        print("  (production cell failed — cannot compute deltas)")
        return 1

    print("  --- deltas vs PRODUCTION ---")
    if slim_unc:
        saved = prod["latency"] - slim_unc["latency"]
        in_cut = prod["in"] - slim_unc["in"]
        print(
            f"  slimming the prompt  ({in_cut:5.0f} fewer input tokens): "
            f"{saved:+8.1f} ms"
        )
    if full_cap:
        saved = prod["latency"] - full_cap["latency"]
        out_cut = prod["out"] - full_cap["out"]
        print(
            f"  capping the output   ({out_cut:5.0f} fewer output tokens): "
            f"{saved:+8.1f} ms"
        )
        if out_cut > 0:
            print(f"  implied cost per output token: {saved / out_cut:6.1f} ms")
    print()
    print("  The factor with the large negative delta is the lever.")
    print("  Reminder: even the best cell here is compared against a 700 ms budget.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_run()))
