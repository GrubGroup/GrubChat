"""Stage 1 verification: drive the Deepgram Flux relay with real speech audio.

Proves the STT ingress works end to end and measures the numbers Stage 1 owes:
time to the first interim word, and time from the end of audio to the confirmed
``EndOfTurn`` (the STT+endpointing share of the ~1293 ms voice-to-voice budget,
whose published allowance is ~300 ms).

Also verifies the doc-derived details that would otherwise fail silently:
``/v2/listen`` (not v1), ``Token`` auth (not Bearer), required ``model``, the
repeated singular ``keyterm`` param, and the one-word ``CloseStream`` frame.

Method: fetch Deepgram's own hosted sample WAV, strip the RIFF header to raw
PCM, and feed it in 20 ms chunks paced in real time — a fake-fast upload would
make endpointing latency meaningless. To make the keyterm path meaningful the
run repeats with biasing OFF and ON so any transcript difference is visible.

Needs DEEPGRAM_API_KEY. Read-only apart from a temp file.

Run:
    cd backend/ai_service
    uv run python -m scripts.probe_flux_stt
"""

from __future__ import annotations

import asyncio
import time
import urllib.request
import wave
from collections.abc import AsyncIterator
from pathlib import Path

from app.ai.voice.keyterms import build_keyterms
from app.ai.voice.stt import DEFAULT_SAMPLE_RATE, TurnEvent, stream_transcription
from app.core.config import settings

SAMPLE_URL = "https://dpgr.am/spacewalk.wav"
SAMPLE_PATH = Path("/tmp/grubgroup_flux_sample.wav")
CHUNK_MS = 20


def _load_pcm() -> tuple[bytes, int, float]:
    """Fetch the sample once and return (raw PCM, sample_rate, duration_s).

    Flux is told encoding=linear16, so the RIFF header must be stripped — sending
    the container bytes as if they were samples yields garbage transcripts.
    """
    if not SAMPLE_PATH.exists():
        urllib.request.urlretrieve(SAMPLE_URL, SAMPLE_PATH)  # noqa: S310 (known host)
    with wave.open(str(SAMPLE_PATH), "rb") as wav:
        rate = wav.getframerate()
        frames = wav.getnframes()
        pcm = wav.readframes(frames)
        return pcm, rate, frames / float(rate)


async def _paced_chunks(pcm: bytes, rate: int, channels: int = 1) -> AsyncIterator[bytes]:
    """Yield PCM in CHUNK_MS slices, sleeping so upload runs at real-time speed."""
    bytes_per_sample = 2 * channels  # linear16
    chunk_bytes = int(rate * (CHUNK_MS / 1000.0)) * bytes_per_sample
    for offset in range(0, len(pcm), chunk_bytes):
        yield pcm[offset : offset + chunk_bytes]
        await asyncio.sleep(CHUNK_MS / 1000.0)


async def _run_once(pcm: bytes, rate: int, keyterms: list[str] | None) -> dict:
    """One Flux session; returns timings + the final transcript."""
    label = f"{len(keyterms)} keyterms" if keyterms else "no keyterms"
    print(f"  --- {label} ---")

    started = time.perf_counter()
    first_word_at: float | None = None
    audio_done_at: float | None = None
    final_at: float | None = None
    last_update_at: float | None = None
    last_len = 0
    finals: list[str] = []
    seen: dict[str, int] = {}

    async def audio() -> AsyncIterator[bytes]:
        nonlocal audio_done_at
        async for chunk in _paced_chunks(pcm, rate):
            yield chunk
        audio_done_at = time.perf_counter()

    async for event in stream_transcription(
        audio(), keyterms=keyterms, sample_rate=rate
    ):
        seen[event.event] = seen.get(event.event, 0) + 1
        now = time.perf_counter()
        if first_word_at is None and event.transcript:
            first_word_at = now
        # Track the last interim whose TEXT GREW. Flux keeps emitting Update
        # frames during trailing silence with an unchanged transcript, so timing
        # from "the last Update" still lands after speech ended; the last frame
        # that added words is the real "user stopped talking" moment.
        if event.event == "Update" and len(event.transcript) > last_len:
            last_len = len(event.transcript)
            last_update_at = now
        if event.is_final:
            final_at = now
            if event.transcript:
                finals.append(event.transcript)

    def ms(mark: float | None) -> float | None:
        return None if mark is None else (mark - started) * 1000.0

    # ENDPOINTING LATENCY — from the last interim that ADDED WORDS to the
    # confirmed EndOfTurn. Two earlier attempts at this measurement were wrong and
    # both produced negative numbers, which is worth recording so nobody
    # "re-fixes" it back:
    #   1. `final_at - audio_done_at`: this clip has ~300 ms of trailing room
    #      tone, and Flux correctly fires EndOfTurn when SPEECH stops — before the
    #      file finishes uploading. Negative by construction.
    #   2. `final_at - last_Update_at`: Flux keeps emitting Update frames through
    #      the trailing silence with an unchanged transcript, so this also lands
    #      after speech ended. Still negative.
    # The last transcript-growing frame is the closest available proxy for "the
    # user stopped talking", which is what the ~300 ms budget line refers to.
    endpoint_ms = (
        (final_at - last_update_at) * 1000.0
        if (final_at and last_update_at)
        else None
    )
    tail_ms = (
        (final_at - audio_done_at) * 1000.0 if (final_at and audio_done_at) else None
    )
    print(f"      events seen        : {seen}")
    ttfw = ms(first_word_at)
    print(f"      first interim word : {ttfw:8.1f} ms" if ttfw else "      first interim word :      n/a")
    print(
        f"      lastword->EndOfTurn: {endpoint_ms:8.1f} ms   (budget ~300 ms)"
        if endpoint_ms is not None
        else "      lastword->EndOfTurn:      n/a  (no EndOfTurn seen)"
    )
    if tail_ms is not None:
        print(
            f"      (EndOfTurn fired {abs(tail_ms):.0f} ms "
            f"{'BEFORE' if tail_ms < 0 else 'after'} the last audio byte — "
            "this clip has trailing silence)"
        )
    print(f"      final turns        : {len(finals)}")
    for text in finals:
        print(f"        {text[:150]}")
    print()
    return {
        "label": label,
        "endpoint_ms": endpoint_ms,
        "first_word_ms": ttfw,
        "finals": finals,
        "events": seen,
    }


async def _run() -> int:
    print("=" * 78)
    print("  Stage 1 — Deepgram Flux STT relay, live")
    print("=" * 78)
    if not settings.deepgram_api_key:
        print("  ABORT: DEEPGRAM_API_KEY is empty.")
        return 1

    pcm, rate, duration = _load_pcm()
    print(f"  sample: {duration:.1f}s of speech @ {rate} Hz, {len(pcm)} PCM bytes")
    print(f"  fed in {CHUNK_MS} ms chunks, paced at real time")
    if rate != DEFAULT_SAMPLE_RATE:
        print(f"  note: sample rate {rate} != default {DEFAULT_SAMPLE_RATE}; passing actual rate")
    print()

    keyterms = await build_keyterms()
    print(f"  keyterms built: {len(keyterms)} terms from the catalog + taxonomy")
    print(f"    first 8: {keyterms[:8]}")
    print()

    unbiased = await _run_once(pcm, rate, None)
    biased = await _run_once(pcm, rate, keyterms)

    print("  --- VERDICT ---")
    ok = bool(unbiased["finals"]) and bool(biased["finals"])
    print(f"      transcription works (both runs produced a final turn): {ok}")
    if not ok:
        print("      NO final turn — check the model/encoding/auth details.")
        return 1
    for result in (unbiased, biased):
        budget = result["endpoint_ms"]
        if budget is not None:
            verdict = "within" if budget <= 300 else f"{budget / 300:.1f}x over"
            print(f"      {result['label']:<16} endpointing {budget:7.1f} ms  ({verdict} ~300 ms)")
    if unbiased["finals"] != biased["finals"]:
        print("      keyterm biasing CHANGED the transcript (expected on domain words)")
    else:
        print("      keyterm biasing did not change this sample (it has no cuisine words)")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_run()))
