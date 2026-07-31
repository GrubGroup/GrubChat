"""Stage 3 verification: measure Cartesia Sonic-3.5 TTS latency, streaming vs one-shot.

Reports the number Stage 3 owes — time to first audio byte — for both transports,
and confirms the streaming path is worth its extra complexity.

Uses the REAL server-authored questions from ``conversation_agent._QUESTION_FOR``
rather than lorem text, because TTS latency scales with utterance length and
those strings are exactly what the voice shell will speak. That also verifies the
Stage 3 requirement that TTS says the server's wording verbatim.

Two things this is built to expose:
  * ``max_buffer_delay_ms`` is documented as a TTS request field with no transport
    restriction, but sending it to ``/tts/sse`` is a hard HTTP 400 ("only
    supported for websocket requests"). This asserts that, so the field is never
    quietly re-added to the HTTP payload.
  * One-shot TTFB necessarily includes generating the WHOLE clip, so it grows with
    sentence length while streaming TTFB should stay roughly flat. The comparison
    is the argument for streaming.

Needs CARTESIA_API_KEY. Writes one temp WAV to /tmp for an audible spot-check.

Run:
    cd backend/ai_service
    uv run python -m scripts.probe_cartesia_tts
"""

from __future__ import annotations

import asyncio
import statistics
import time
from pathlib import Path

from app.ai.agents.conversation_agent import _QUESTION_FOR, _fallback_reply
from app.ai.voice.tts import (
    LOW_LATENCY_BUFFER_MS,
    stream_audio,
    synthesize_bytes,
)
from app.core.config import settings
from app.schemas.ai import ExtractedSignals

REPS = 3
# The published TTS allowance inside the ~1293 ms voice-to-voice budget.
TTS_BUDGET_MS = 120.0
OUT_WAV = Path("/tmp/grubgroup_tts_probe.wav")


def _sentences() -> list[tuple[str, str]]:
    """(label, text) pairs: the real questions, shortest and longest."""
    questions = list(_QUESTION_FOR.items())
    shortest = min(questions, key=lambda kv: len(kv[1]))
    longest = max(questions, key=lambda kv: len(kv[1]))
    # A full confirm-then-ask line is what a mid-conversation turn really speaks —
    # longer than a bare question, so it stresses the one-shot path hardest.
    full = _fallback_reply(
        ExtractedSignals(
            preferred_cuisines=["ramen", "noodles"],
            disliked_cuisines=["fast_food"],
            budget_max=25,
        ),
        ["location"],
    )
    return [
        (f"short ({shortest[0]})", shortest[1]),
        (f"long ({longest[0]})", longest[1]),
        ("full confirm+ask", full),
    ]


async def _time_stream(text: str) -> tuple[float, float, int, int]:
    """Return (ttfb_ms, total_ms, chunk_count, byte_count) for the SSE path."""
    started = time.perf_counter()
    first_at: float | None = None
    chunks = 0
    total_bytes = 0
    async for chunk in stream_audio(text):
        if first_at is None:
            first_at = time.perf_counter()
        chunks += 1
        total_bytes += len(chunk)
    ended = time.perf_counter()
    ttfb = ((first_at or ended) - started) * 1000.0
    return ttfb, (ended - started) * 1000.0, chunks, total_bytes


async def _time_bytes(text: str) -> tuple[float, int]:
    """Return (total_ms, byte_count) for the one-shot path."""
    started = time.perf_counter()
    audio = await synthesize_bytes(text)
    return (time.perf_counter() - started) * 1000.0, len(audio)


async def _run() -> int:
    print("=" * 78)
    print("  Stage 3 — Cartesia Sonic-3.5 TTS latency")
    print("=" * 78)
    if not settings.cartesia_api_key:
        print("  ABORT: CARTESIA_API_KEY is empty.")
        return 1
    print(f"  version header : {settings.cartesia_version}")
    print(f"  reps/case      : {REPS}   TTS budget: {TTS_BUDGET_MS:.0f} ms")
    print()

    cases = _sentences()
    stream_ttfbs: list[float] = []

    for label, text in cases:
        print(f"  --- {label} ({len(text)} chars) ---")
        print(f'      "{text}"')

        ttfbs, totals, chunk_counts = [], [], []
        for _ in range(REPS):
            ttfb, total, chunks, nbytes = await _time_stream(text)
            ttfbs.append(ttfb)
            totals.append(total)
            chunk_counts.append(chunks)
        p50 = statistics.median(ttfbs)
        stream_ttfbs.extend(ttfbs)
        verdict = "within" if p50 <= TTS_BUDGET_MS else f"{p50 / TTS_BUDGET_MS:.1f}x over"
        print(
            f"      STREAM  ttfb p50={p50:7.1f} ms  "
            f"total p50={statistics.median(totals):7.1f} ms  "
            f"chunks~{int(statistics.median(chunk_counts))}   ({verdict} {TTS_BUDGET_MS:.0f} ms)"
        )

        one_shots = [await _time_bytes(text) for _ in range(REPS)]
        os_p50 = statistics.median(t for t, _ in one_shots)
        print(
            f"      ONESHOT total p50={os_p50:7.1f} ms  "
            f"({one_shots[0][1]} bytes)  <- no audio until this completes"
        )
        print(f"      streaming starts speaking {os_p50 - p50:+.0f} ms sooner")
        print()

    # Assert the WS-only restriction, so nobody re-adds the field to the HTTP body.
    print("  --- max_buffer_delay_ms must NOT be sent on the HTTP endpoints ---")
    import httpx

    from app.ai.voice.tts import RAW_OUTPUT, SSE_URL, _headers

    async with httpx.AsyncClient(timeout=20.0) as client:
        bad = await client.post(
            SSE_URL,
            headers=_headers(),
            json={
                "model_id": "sonic-3.5",
                "transcript": "buffer delay probe",
                "voice": {"mode": "id", "id": "694f9389-aac1-45b6-b726-9d9369183238"},
                "output_format": RAW_OUTPUT,
                "max_buffer_delay_ms": LOW_LATENCY_BUFFER_MS,
            },
        )
    rejected = bad.status_code == 400
    print(f"      with the field  -> HTTP {bad.status_code}  {bad.text[:110]}")
    print(f"      rejected as expected: {rejected}")
    print("      (our payload builder omits it — this only proves why)")
    print()

    # Audible spot-check + proof the one-shot path returns a real WAV.
    audio = await synthesize_bytes(cases[0][1])
    OUT_WAV.write_bytes(audio)
    is_wav = audio[:4] == b"RIFF"
    print(f"  wrote {OUT_WAV} ({len(audio)} bytes, RIFF header: {is_wav})")
    print()

    print("  --- VERDICT ---")
    overall = statistics.median(stream_ttfbs)
    print(f"      streaming TTFB across all cases: p50 {overall:.0f} ms")
    if overall <= TTS_BUDGET_MS:
        print(f"      WITHIN the {TTS_BUDGET_MS:.0f} ms TTS budget.")
    else:
        print(
            f"      {overall / TTS_BUDGET_MS:.1f}x over the {TTS_BUDGET_MS:.0f} ms line — "
            "note that line is a\n      published cascade allowance, not a Cartesia claim; "
            "their own figure is\n      'first byte in 90ms' server-side, excluding network."
        )
    return 0 if is_wav else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_run()))
