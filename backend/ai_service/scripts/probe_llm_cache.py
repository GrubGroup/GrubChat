"""Diagnostic: does the active LLM gateway cache identical prompts?

Exists because the first Stage 0 latency run produced implausible numbers — a
122 ms full JSON completion from Claude Sonnet, with a cold/warm spread of
~4072 ms vs ~122 ms across reps that replayed the SAME conversation. That is the
signature of response caching, not of a fast model. If the gateway caches, then
any latency harness that replays a fixed script measures the cache on reps 2+
and the resulting p50 is meaningless for capacity planning.

Method: send one identical prompt three times, then three prompts made unique by
a nonce. Caching shows up as repeats collapsing to near-zero while the unique
calls stay at full cost.

Run:
    cd backend/ai_service
    uv run python -m scripts.probe_llm_cache
"""

from __future__ import annotations

import asyncio
import time

from app.ai.llm.client import chat_completion
from app.core.config import settings


async def _timed(messages: list[dict[str, str]]) -> tuple[float, int]:
    """Return (elapsed_ms, response_char_len) for one completion."""
    started = time.perf_counter()
    reply = await chat_completion(messages, temperature=0.2)
    return (time.perf_counter() - started) * 1000.0, len(reply or "")


async def _run() -> int:
    print(f"provider={settings.llm_provider}  model={settings.active_llm_model}")
    print()

    identical = [
        {"role": "user", "content": 'Reply with exactly this JSON: {"ok": 1}'}
    ]
    print("--- IDENTICAL prompt x3 (cache would collapse these) ---")
    same_samples: list[float] = []
    for i in range(3):
        elapsed, length = await _timed(identical)
        same_samples.append(elapsed)
        print(f"  call {i + 1}: {elapsed:8.1f} ms   len={length}")

    print("--- UNIQUE prompts x3 (nonce defeats a cache) ---")
    uniq_samples: list[float] = []
    for i in range(3):
        messages = [
            {
                "role": "user",
                "content": (
                    "Reply with exactly this JSON: "
                    f'{{"ok": {i}, "nonce": "zq{i}7f"}}'
                ),
            }
        ]
        elapsed, length = await _timed(messages)
        uniq_samples.append(elapsed)
        print(f"  call {i + 1}: {elapsed:8.1f} ms   len={length}")

    print()
    # Compare the REPEATS (calls 2-3) against the unique calls; call 1 of the
    # identical set is itself a cold miss and would muddy the ratio.
    repeats = same_samples[1:]
    warm = sum(repeats) / len(repeats)
    cold = sum(uniq_samples) / len(uniq_samples)
    print(f"identical repeats mean = {warm:8.1f} ms")
    print(f"unique  calls    mean = {cold:8.1f} ms")
    if cold > 0 and warm < cold * 0.5:
        print(f"\nVERDICT: CACHING LIKELY (repeats {cold / max(warm, 0.001):.1f}x faster).")
        print("A fixed-script latency harness measures the cache, not the model.")
        print("Any Stage 0 number must come from UNIQUE prompts per sample.")
    else:
        print("\nVERDICT: no strong caching signal; repeat timings track unique ones.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_run()))
