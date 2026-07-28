"""Stage 5 verification: drive the voice WebSocket end to end, no gateway/browser.

Opens ``ws://…/api/v1/voice/session`` directly (the same auth header the gateway
sends), streams a real WAV paced at real time, and asserts the FULL chain the
browser will depend on:

    ready -> caption -> turn_final -> turn_result -> PCM audio -> speech_end

It reports the per-leg latency that makes up the ~1293 ms voice-to-voice budget:
STT endpointing (audio-end -> turn_final), analyze (turn_final -> turn_result),
and TTS TTFB (turn_result -> first downstream PCM byte). This is the one probe
that exercises the whole ai_service leg wired together — the individual legs have
their own probes (``probe_flux_stt`` / ``probe_cartesia_tts``).

Needs a RUNNING ai_service (``uv run uvicorn app.main:app``), DEEPGRAM_API_KEY,
CARTESIA_API_KEY, and a REAL ``(session_id, user_id)`` in the DB (analyze writes
that member's Qa row, which FK-references the session). Override via env:

    VOICE_PROBE_SESSION_ID=42 VOICE_PROBE_USER_ID=7 \
        uv run python -m scripts.probe_voice_session

The endpoint assumes 16 kHz linear16 (what the browser AudioWorklet sends), so a
sample at another rate is resampled to 16 kHz here in pure Python (Python 3.14
dropped ``audioop``) before streaming.

Run:
    cd backend/ai_service
    uv run uvicorn app.main:app            # in another shell
    uv run python -m scripts.probe_voice_session
"""

from __future__ import annotations

import array
import asyncio
import contextlib
import json
import os
import time
import urllib.request
import wave
from pathlib import Path

import websockets

from app.core.config import settings

# A short clip with clear speech. Resampled to 16 kHz below regardless of source.
SAMPLE_URL = "https://dpgr.am/spacewalk.wav"
SAMPLE_PATH = Path("/tmp/grubgroup_voice_probe.wav")
TARGET_RATE = 16_000
CHUNK_MS = 80  # the browser AudioWorklet's frame size
WS_BASE = os.getenv("VOICE_PROBE_WS", "ws://localhost:8000")
SESSION_ID = int(os.getenv("VOICE_PROBE_SESSION_ID", "1"))
USER_ID = int(os.getenv("VOICE_PROBE_USER_ID", "1"))


def _load_16k_pcm() -> bytes:
    """Fetch the sample and return raw 16 kHz mono linear16 PCM.

    Strips the RIFF header, downmixes to mono, and linearly resamples to 16 kHz —
    the rate the voice endpoint assumes (it does not pass sample_rate through).
    """
    if not SAMPLE_PATH.exists():
        urllib.request.urlretrieve(SAMPLE_URL, SAMPLE_PATH)  # noqa: S310 (known host)
    with wave.open(str(SAMPLE_PATH), "rb") as wav:
        rate = wav.getframerate()
        channels = wav.getnchannels()
        frames = wav.readframes(wav.getnframes())

    samples = array.array("h")
    samples.frombytes(frames)
    if channels > 1:  # downmix: keep the first channel
        samples = array.array("h", samples[::channels])

    if rate != TARGET_RATE:
        ratio = TARGET_RATE / rate
        out_len = int(len(samples) * ratio)
        resampled = array.array("h", [0] * out_len)
        for i in range(out_len):  # linear interpolation
            src = i / ratio
            lo = int(src)
            hi = min(lo + 1, len(samples) - 1)
            frac = src - lo
            resampled[i] = int(samples[lo] * (1 - frac) + samples[hi] * frac)
        samples = resampled
    return samples.tobytes()


async def _run() -> int:
    print("=" * 78)
    print("  Stage 5 — voice WebSocket, full chain (STT -> analyze -> TTS)")
    print("=" * 78)
    missing = [
        name
        for name, val in (
            ("DEEPGRAM_API_KEY", settings.deepgram_api_key),
            ("CARTESIA_API_KEY", settings.cartesia_api_key),
        )
        if not val
    ]
    if missing:
        print(f"  ABORT: {', '.join(missing)} not set.")
        return 1

    pcm = _load_16k_pcm()
    chunk_bytes = int(TARGET_RATE * (CHUNK_MS / 1000.0)) * 2  # linear16 mono
    url = f"{WS_BASE}/api/v1/voice/session?session_id={SESSION_ID}&user_id={USER_ID}"
    print(f"  connecting: {url}")
    print(f"  streaming {len(pcm)} PCM bytes @16kHz in {CHUNK_MS} ms chunks, real time")
    print(f"  session_id={SESSION_ID} user_id={USER_ID}  (must exist in the DB)\n")

    marks: dict[str, float] = {}
    captions = 0
    pcm_bytes = 0
    audio_done_at: float | None = None

    try:
        async with websockets.connect(
            url, additional_headers={"X-Internal-Secret": settings.jwt_secret}
        ) as ws:

            async def send() -> None:
                nonlocal audio_done_at
                await ws.send(json.dumps({"type": "start"}))
                marks["audio_start"] = time.perf_counter()
                for off in range(0, len(pcm), chunk_bytes):
                    await ws.send(pcm[off : off + chunk_bytes])
                    await asyncio.sleep(CHUNK_MS / 1000.0)
                audio_done_at = time.perf_counter()
                # Keep the mic warm briefly so Flux can finalize the last turn.
                for _ in range(40):  # up to ~3.2 s of trailing silence
                    await ws.send(b"\x00" * chunk_bytes)
                    await asyncio.sleep(CHUNK_MS / 1000.0)

            sender = asyncio.create_task(send())
            try:
                while True:
                    raw = await asyncio.wait_for(ws.recv(), timeout=30.0)
                    now = time.perf_counter()
                    if isinstance(raw, bytes):
                        if "first_pcm" not in marks:
                            marks["first_pcm"] = now
                        pcm_bytes += len(raw)
                        continue
                    frame = json.loads(raw)
                    ftype = frame.get("type")
                    marks.setdefault(ftype, now)
                    if ftype == "caption":
                        captions += 1
                    if ftype in ("caption",):
                        continue
                    print(f"    <- {ftype}: {json.dumps(frame)[:120]}")
                    if ftype in ("speech_end", "complete"):
                        break
            finally:
                with contextlib.suppress(Exception):
                    await ws.send(json.dumps({"type": "stop"}))
                sender.cancel()
    except Exception as exc:
        print(f"  ERROR: {type(exc).__name__}: {exc}")
        return 1

    def leg(a: str, b: str) -> str:
        if a in marks and b in marks:
            return f"{(marks[b] - marks[a]) * 1000:8.1f} ms"
        return "     n/a"

    print("\n  --- per-leg latency ---")
    if audio_done_at is not None and "turn_final" in marks:
        print(f"      audio-end -> turn_final (STT endpoint): "
              f"{(marks['turn_final'] - audio_done_at) * 1000:8.1f} ms")
    print(f"      turn_final -> turn_result (analyze)   : {leg('turn_final', 'turn_result')}")
    print(f"      turn_result -> first PCM (TTS TTFB)   : {leg('turn_result', 'first_pcm')}")
    print(f"      captions seen: {captions}   downstream PCM: {pcm_bytes} bytes")

    print("\n  --- VERDICT ---")
    need = ["ready", "caption", "turn_final", "turn_result", "first_pcm"]
    ok = all(k in marks for k in need)
    for k in need:
        print(f"      {k:<12}: {'seen' if k in marks else 'MISSING'}")
    print(f"      FULL CHAIN {'OK' if ok else 'INCOMPLETE'}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_run()))
