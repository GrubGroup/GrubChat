"""Diagnostic: can a minimal-output analyze turn reach the ~700 ms voice budget?

``scripts/probe_token_cost.py`` established the turn is OUTPUT-bound: stripping
2439 input tokens saved 42 ms (noise), while cutting 123 output tokens saved
1593 ms — about **13 ms per output token** on the active provider. Production
emits ~187 output tokens, so generation alone costs ~2.4 s.

That makes the output shape the only lever that matters, and there is real slack
in it. Today the turn returns:
  (a) the FULL reconciled signal set — every field, every expanded taxonomy tag,
      re-emitted verbatim each turn even when the user changed one thing; and
  (b) a prose ``agent_reply`` whose next-question half the SERVER already
      authors deterministically from ``missing_signals``.

Both are avoidable. This probe times four output shapes on the same provider,
from production down to a delta-only extraction with no prose at all, and reports
each against the 700 ms LLM-leg budget. The point is to find out whether ANY
shape fits — because if none does, no STT/TTS vendor choice can rescue the
voice-to-voice target and the architecture needs a different answer.

Shapes:
  1. PRODUCTION      — full signals + prose reply (the baseline).
  2. delta + prose    — only fields that CHANGED, plus a short confirm.
  3. delta + confirm  — changed fields plus a <=12-word confirm (server asks
                        the next question, per the existing design).
  4. delta only       — changed fields, zero prose. Server authors the entire
                        spoken line. The theoretical floor.

Run:
    cd backend/ai_service
    uv run python -m scripts.probe_minimal_output
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
from app.ai.llm.prompts import PREFERENCE_TURN_SYSTEM
from app.core.config import settings

REPS = 5
LLM_LEG_BUDGET_MS = 700.0
MESSAGE = "i'm not feeling greasy food, want something lighter to eat"

# Shape 2/3/4 share the taxonomy-bearing production system prompt (input tokens
# are free per probe_token_cost) and differ ONLY in the output contract, so the
# measured delta is attributable to output shape alone.
_DELTA_RULES = (
    "\n\n=== OUTPUT OVERRIDE (supersedes the JSON shape above) ===\n"
    "Return ONLY the signal fields whose value CHANGED this turn — omit every "
    "unchanged field entirely. Do not echo the full signal set.\n"
)

_SHAPES: dict[str, str] = {
    "delta + prose": _DELTA_RULES
    + 'Keys: "extracted_signals" (changed fields only), "agent_reply" (one or two '
    'short sentences), "missing_signals". JSON only.',
    "delta + short confirm": _DELTA_RULES
    + 'Keys: "extracted_signals" (changed fields only), "agent_reply" (a confirm '
    "of at most 12 words — do NOT ask a question, the server appends it), "
    '"missing_signals". JSON only.',
    "delta only (no prose)": _DELTA_RULES
    + 'Keys: "extracted_signals" (changed fields only), "missing_signals". '
    "Emit NO agent_reply and no prose at all. JSON only.",
}


def _mean(values: list[float]) -> float:
    return statistics.mean(values) if values else float("nan")


async def _time_shape(
    client: AsyncOpenAI, model: str, label: str, system: str
) -> dict[str, Any]:
    """Time REPS calls for one output shape; validate JSON; report vs budget."""
    latencies: list[float] = []
    out_tokens: list[int] = []
    parse_failures = 0
    sample_output = ""

    for rep in range(REPS):
        messages = [
            {"role": "system", "content": system},
            {
                "role": "user",
                "content": (
                    "MESSAGE_SOURCE: voice\nUSER_ROLE: MEMBER\n"
                    'CURRENT_SIGNALS (captured so far):\n{}\n\n'
                    f"NEW USER_MESSAGE:\n{MESSAGE} (ref {rep})\n\n"
                    "Return the updated strict JSON object now."
                ),
            },
        ]
        started = time.perf_counter()
        try:
            response = await client.chat.completions.create(
                model=model, messages=messages, temperature=0.2
            )
        except Exception as exc:
            print(f"  {label:<30} FAILED: {type(exc).__name__}: {str(exc)[:60]}")
            return {}
        latencies.append((time.perf_counter() - started) * 1000.0)

        content = response.choices[0].message.content or ""
        usage = getattr(response, "usage", None)
        if usage and getattr(usage, "completion_tokens", None):
            out_tokens.append(usage.completion_tokens)
        if not rep:
            sample_output = content
        try:
            if not isinstance(json.loads(strip_json_fence(content)), dict):
                parse_failures += 1
        except (ValueError, TypeError):
            parse_failures += 1

    p50 = statistics.median(latencies)
    fits = "FITS" if p50 <= LLM_LEG_BUDGET_MS else f"{p50 / LLM_LEG_BUDGET_MS:.1f}x over"
    warn = f"  [{parse_failures}/{REPS} UNPARSEABLE]" if parse_failures else ""
    print(
        f"  {label:<30} p50={p50:8.1f} ms  mean={_mean(latencies):8.1f}  "
        f"out={_mean(out_tokens):5.0f} tok  {fits}{warn}"
    )
    return {
        "p50": p50,
        "out": _mean(out_tokens) if out_tokens else float("nan"),
        "sample": sample_output,
        "parse_failures": parse_failures,
    }


async def _run() -> int:
    print("=" * 78)
    print("  Can a minimal-output turn reach the 700 ms LLM-leg budget?")
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

    print(f"  provider={provider}  model={model}  reps/shape={REPS}")
    print(f"  budget={LLM_LEG_BUDGET_MS:.0f} ms   (~13 ms per output token measured)")
    print()

    results: dict[str, dict[str, Any]] = {}
    results["PRODUCTION"] = await _time_shape(
        client, model, "1. PRODUCTION (baseline)", PREFERENCE_TURN_SYSTEM
    )
    for idx, (label, override) in enumerate(_SHAPES.items(), start=2):
        results[label] = await _time_shape(
            client, model, f"{idx}. {label}", PREFERENCE_TURN_SYSTEM + override
        )
    print()

    baseline = results.get("PRODUCTION") or {}
    floor = results.get("delta only (no prose)") or {}
    if baseline and floor:
        print("  --- best case vs production ---")
        print(
            f"  output tokens: {baseline['out']:.0f} -> {floor['out']:.0f}   "
            f"latency p50: {baseline['p50']:.0f} ms -> {floor['p50']:.0f} ms "
            f"({baseline['p50'] - floor['p50']:+.0f} ms)"
        )
        if floor["p50"] > LLM_LEG_BUDGET_MS:
            print(
                f"  Even the ZERO-PROSE floor is {floor['p50'] / LLM_LEG_BUDGET_MS:.1f}x "
                "over the 700 ms LLM-leg budget."
            )
            print(
                "  => Output trimming alone cannot make this provider fit a "
                "sub-1.3 s\n     voice-to-voice target. The provider/model tier is "
                "the real constraint."
            )
        else:
            print("  => A minimal-output turn FITS. Output shape was the whole problem.")
        print()
        sample = (floor.get("sample") or "").replace("\n", " ")[:200]
        print(f"  delta-only sample output: {sample}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_run()))
