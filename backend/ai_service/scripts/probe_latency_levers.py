"""Diagnostic: WHICH part of the analyze turn costs the ~3.9 s, and what would fix it?

``scripts/measure_analyze_latency.py`` established that the LLM leg of the
conversational turn runs ~3.9 s p50 — about 5.6x the ~700 ms voice budget. That
result says the LLM leg is the binding constraint but not WHY, and the fix
differs completely depending on the cause:

  * If cost scales with the ~2.4k-token PROMPT, the lever is prompt slimming
    (the taxonomy catalogs dominate the system prompt).
  * If cost scales with OUTPUT tokens, the lever is asking for less JSON — the
    turn currently emits the full signal set plus a prose reply every time.
  * If it is mostly fixed per-call overhead (provider queueing / a slow model),
    prompt work is wasted and the lever is the provider or the model tier.

This probe separates those by timing four variants against the SAME provider,
plus the alternate provider if its key is present. Every call is nonce-varied
because the active gateway caches identical prompts (see probe_llm_cache.py).

Run:
    cd backend/ai_service
    uv run python -m scripts.probe_latency_levers
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

REPS = 3
MESSAGE = "i'm not feeling greasy food, want something lighter to eat"


def _mean(values: list[float]) -> float:
    return statistics.mean(values) if values else float("nan")


async def _time_call(
    client: AsyncOpenAI, model: str, messages: list[dict[str, Any]], *, max_tokens: int | None
) -> tuple[float, int]:
    """One completion; returns (elapsed_ms, completion_token_count or -1)."""
    kwargs: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": 0.2,
    }
    if max_tokens is not None:
        kwargs["max_tokens"] = max_tokens
    started = time.perf_counter()
    response = await client.chat.completions.create(**kwargs)
    elapsed = (time.perf_counter() - started) * 1000.0
    usage = getattr(response, "usage", None)
    out_tokens = getattr(usage, "completion_tokens", None) if usage else None
    return elapsed, (out_tokens if out_tokens is not None else -1)


async def _run_variant(
    label: str,
    client: AsyncOpenAI,
    model: str,
    build: Any,
    *,
    max_tokens: int | None = None,
) -> None:
    """Time one variant REPS times with a per-rep nonce, then report."""
    samples: list[float] = []
    out_tokens: list[int] = []
    for rep in range(REPS):
        try:
            elapsed, tokens = await _time_call(
                client, model, build(rep), max_tokens=max_tokens
            )
        except Exception as exc:
            print(f"  {label:<40} FAILED: {type(exc).__name__}: {exc}")
            return
        samples.append(elapsed)
        if tokens >= 0:
            out_tokens.append(tokens)
    tok_note = f"  out_tok~{int(_mean(out_tokens))}" if out_tokens else ""
    print(
        f"  {label:<40} mean={_mean(samples):8.1f} ms  "
        f"min={min(samples):7.1f}  max={max(samples):7.1f}{tok_note}"
    )


def _full_prompt(rep: int) -> list[dict[str, Any]]:
    """The REAL production prompt (full taxonomy catalogs), nonce-varied."""
    return build_preference_turn_messages(
        f"{MESSAGE} (ref {rep})",
        current_signals=ExtractedSignals().model_dump(),
        message_source="voice",
        is_host=False,
    )


def _tiny_prompt(rep: int) -> list[dict[str, Any]]:
    """A minimal slot-extraction prompt: no taxonomy catalogs, same task shape.

    Isolates how much of the cost is the ~2.4k-token system prompt. If this is
    dramatically faster, prompt slimming is a real lever; if not, the cost is
    per-call overhead or output generation.
    """
    return [
        {
            "role": "system",
            "content": (
                "Extract dining preferences as strict JSON with keys "
                '"extracted_signals" (preferred_cuisines, disliked_cuisines, '
                'budget_min, budget_max as lists/ints), "agent_reply" (one short '
                'sentence), "missing_signals" (list). JSON only, no prose.'
            ),
        },
        {"role": "user", "content": f"{MESSAGE} (ref {rep})"},
    ]


def _reply_only(rep: int) -> list[dict[str, Any]]:
    """Full prompt but capped output — isolates OUTPUT-token cost.

    The production turn emits the whole reconciled signal set plus a prose reply.
    Capping tokens shows how much of the wall-clock is generation rather than
    time-to-first-token / queueing.
    """
    return _full_prompt(rep)


async def _run() -> int:
    print("=" * 78)
    print("  Which lever moves the ~3.9 s analyze turn?")
    print("=" * 78)
    print(f"  active provider: {settings.llm_provider}  model: {settings.active_llm_model}")
    print(f"  reps per variant: {REPS}  (nonce-varied — cache defeated)")
    print()

    provider = settings.llm_provider.strip().lower()
    if provider == "salesforce":
        if not settings.salesforce_api_key:
            print("  ABORT: SALESFORCE_API_KEY empty.")
            return 1
        active = AsyncOpenAI(
            api_key=settings.salesforce_api_key,
            base_url=settings.salesforce_base_url,
            http_client=httpx.AsyncClient(verify=settings.node_extra_ca_certs or True),
        )
        active_model = settings.salesforce_llm_model
    else:
        if not settings.openrouter_api_key:
            print("  ABORT: OPENROUTER_API_KEY empty.")
            return 1
        active = AsyncOpenAI(
            api_key=settings.openrouter_api_key,
            base_url=settings.openrouter_base_url,
        )
        active_model = settings.openrouter_llm_model

    full = sum(len(m["content"]) for m in _full_prompt(0))
    tiny = sum(len(m["content"]) for m in _tiny_prompt(0))
    print(f"  --- {provider} / {active_model} ---")
    print(f"  (full prompt ~{full // 4} tok, slim prompt ~{tiny // 4} tok)")
    await _run_variant("full prompt, uncapped (PRODUCTION)", active, active_model, _full_prompt)
    await _run_variant("full prompt, max_tokens=64", active, active_model, _reply_only, max_tokens=64)
    await _run_variant("slim prompt, uncapped", active, active_model, _tiny_prompt)
    await _run_variant("slim prompt, max_tokens=64", active, active_model, _tiny_prompt, max_tokens=64)
    print()

    # The alternate provider — the single biggest available lever if the cost is
    # per-call overhead rather than prompt size. Only runs if its key exists.
    if provider == "salesforce" and settings.openrouter_api_key:
        alt = AsyncOpenAI(
            api_key=settings.openrouter_api_key,
            base_url=settings.openrouter_base_url,
        )
        alt_model = settings.openrouter_llm_model
        print(f"  --- ALTERNATE: openrouter / {alt_model} ---")
        await _run_variant("full prompt, uncapped", alt, alt_model, _full_prompt)
        await _run_variant("slim prompt, uncapped", alt, alt_model, _tiny_prompt)
        print()
    elif provider == "salesforce":
        print("  (no OPENROUTER_API_KEY — cannot compare the alternate provider)")
        print()

    print("  Read the table: if slim ~= full, prompt size is NOT the lever.")
    print("  If max_tokens=64 ~= uncapped, output generation is NOT the lever")
    print("  either — the cost is per-call overhead (provider/model tier).")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_run()))
