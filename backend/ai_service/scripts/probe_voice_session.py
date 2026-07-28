"""Stage 5 verification: drive the voice WebSocket end to end, no gateway/browser.

Opens ``ws://…/api/v1/voice/session`` directly (the same auth header the gateway
sends) and asserts the FULL chain the browser depends on, PER TURN:

    ready -> caption -> turn_final -> turn_result -> PCM audio -> speech_end

and reports the per-leg latency that makes up the voice-to-voice budget.

Two modes:

  * ``--live`` (DEFAULT): capture your REAL microphone at 16 kHz and stream it,
    so the numbers come from your own speech. Local RMS voice-activity detection
    timestamps when you STOPPED talking, so "STT endpoint" is anchored to actual
    speech-end (what Flux's end-of-turn timer keys off), not to some arbitrary
    end-of-buffer. Speak the 4-question walk; it prints a line per turn and a
    p50/min/max summary on exit (``complete`` frame or Ctrl+C).
  * ``--wav [PATH_OR_URL]``: stream a canned clip instead (offline / CI). A
    single short utterance is the only meaningful input here — a multi-sentence
    clip makes the STT anchor unreliable (Flux may split it into several turns).

Why the anchors matter (correcting the earlier probe): the previous version
anchored STT to "last chunk sent" and only measured the FIRST turn via
``marks.setdefault`` + break, so a 13 s clip reported a 13 s "STT endpoint". The
real perceived latency is *last speech sample -> turn_final*, and it inherently
INCLUDES Flux's configured ``eot_timeout_ms`` wait (the model deliberately waits
to be sure you're done). We report both the perceived number and a processing-only
estimate (perceived minus that configured wait).

Needs a RUNNING ai_service (``uv run uvicorn app.main:app``), DEEPGRAM_API_KEY,
CARTESIA_API_KEY, and a REAL ``(session_id, user_id)`` in the DB (analyze writes
that member's Qa row, which FK-references the session). Override via env:

    VOICE_PROBE_SESSION_ID=42 VOICE_PROBE_USER_ID=7 \
        uv run python -m scripts.probe_voice_session            # live mic

    uv run python -m scripts.probe_voice_session --wav          # canned clip

The endpoint assumes 16 kHz mono linear16 (what the browser AudioWorklet sends);
``--wav`` resamples to 16 kHz here in pure Python (3.14 dropped ``audioop``). The
probe does NOT play the TTS back (it measures only) — use the browser for hearing.

Run:
    cd backend/ai_service
    uv run uvicorn app.main:app            # in another shell
    uv run python -m scripts.probe_voice_session
"""

from __future__ import annotations

import argparse
import array
import asyncio
import contextlib
import json
import math
import os
import time
import urllib.request
import wave
from pathlib import Path

import websockets

from app.core.config import settings

# ---- audio constants --------------------------------------------------------
TARGET_RATE = 16_000
CHUNK_MS = 80  # the browser AudioWorklet's frame size
CHUNK_SAMPLES = TARGET_RATE * CHUNK_MS // 1000  # 1280
CHUNK_BYTES = CHUNK_SAMPLES * 2  # linear16 mono
_SILENCE = b"\x00" * CHUNK_BYTES

# RMS above this (int16 scale, ~0..32767) counts as speech for the LOCAL
# speech-end anchor. Normal talking sits well above; room tone sits below.
# Override with VOICE_PROBE_VAD if your mic runs hot/quiet.
VAD_THRESHOLD = float(os.getenv("VOICE_PROBE_VAD", "300"))

# ---- connection -------------------------------------------------------------
WS_BASE = os.getenv("VOICE_PROBE_WS", "ws://localhost:8000")
SESSION_ID = int(os.getenv("VOICE_PROBE_SESSION_ID", "113"))
USER_ID = int(os.getenv("VOICE_PROBE_USER_ID", "3"))

# A short clip for --wav mode. ONE utterance keeps the STT anchor meaningful.
SAMPLE_URL = "https://dpgr.am/spacewalk.wav"
SAMPLE_PATH = Path("/tmp/grubgroup_voice_probe.wav")


def _rms_i16(pcm: bytes) -> float:
    """RMS of a linear16 mono chunk (no numpy — array + math is plenty at 80 ms)."""
    a = array.array("h")
    a.frombytes(pcm)
    if not a:
        return 0.0
    return math.sqrt(sum(s * s for s in a) / len(a))


def _load_16k_pcm(source: str) -> bytes:
    """Fetch/open a WAV and return raw 16 kHz mono linear16 PCM.

    Strips the RIFF header, downmixes to mono, and linearly resamples to 16 kHz —
    the rate the voice endpoint assumes (it does not pass sample_rate through).
    """
    if source.startswith(("http://", "https://")):
        if not SAMPLE_PATH.exists():
            urllib.request.urlretrieve(source, SAMPLE_PATH)  # noqa: S310 (known host)
        path = SAMPLE_PATH
    else:
        path = Path(source)
    with wave.open(str(path), "rb") as wav:
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


class _State:
    """Shared measurement state between the sender and receiver coroutines."""

    def __init__(self) -> None:
        self.done = False
        # perf_counter of the most recent SPEECH chunk (RMS > threshold). This is
        # the anchor for STT-endpoint latency — Flux's EOT timer keys off the last
        # real speech, so this is when it starts counting down.
        self.last_speech_at: float | None = None
        # perf_counter of the first speech chunk since the last turn finalized —
        # for a "speech-start -> first live caption" responsiveness read.
        self.turn_speech_start: float | None = None
        # The turn currently being measured (set at turn_final, closed at speech_end).
        self.cur: dict | None = None
        self.turns: list[dict] = []


def _finalize(state: _State, *, at: float) -> None:
    """Close the in-flight turn record and print its one-line result."""
    cur = state.cur
    if cur is None:
        return
    cur.setdefault("t_speech_end", at)
    state.turns.append(cur)
    state.cur = None

    n = len(state.turns)
    stt = _ms(cur.get("speech_end_local"), cur.get("t_final"))
    analyze = _ms(cur.get("t_final"), cur.get("t_result"))
    ttfb = _ms(cur.get("t_result"), cur.get("first_pcm"))
    reply = _ms(cur.get("speech_end_local"), cur.get("first_pcm"))  # perceived v2v
    print(
        f"    turn {n}: stt={stt}  analyze={analyze}  ttfb={ttfb}  "
        f"reply(perceived)={reply}  captions={cur.get('captions', 0)}  "
        f"pcm={cur.get('pcm_bytes', 0)}B"
    )


def _ms(a: float | None, b: float | None) -> str:
    if a is None or b is None:
        return "  n/a"
    return f"{(b - a) * 1000:6.0f}ms"


def _vals(turns: list[dict], a: str, b: str) -> list[float]:
    out = []
    for t in turns:
        if t.get(a) is not None and t.get(b) is not None:
            out.append((t[b] - t[a]) * 1000.0)
    return out


def _pct(vals: list[float], p: float) -> float:
    if not vals:
        return float("nan")
    s = sorted(vals)
    k = max(0, min(len(s) - 1, int(round((p / 100.0) * (len(s) - 1)))))
    return s[k]


def _summary_row(label: str, vals: list[float]) -> str:
    if not vals:
        return f"      {label:<34}:      n/a"
    return (
        f"      {label:<34}: p50 {_pct(vals, 50):6.0f}ms   "
        f"min {min(vals):6.0f}ms   max {max(vals):6.0f}ms   (n={len(vals)})"
    )


async def _capture_live(ws, state: _State) -> None:
    """Stream the real microphone at 16 kHz, tagging speech-end locally."""
    import sounddevice as sd  # dev-only dep; imported lazily so --wav needs no mic

    loop = asyncio.get_running_loop()
    q: asyncio.Queue[bytes] = asyncio.Queue()

    def _cb(indata, _frames, _time, status) -> None:  # runs on the audio thread
        if status:
            # Overflows just mean we briefly couldn't keep up; not fatal for a probe.
            pass
        loop.call_soon_threadsafe(q.put_nowait, bytes(indata))

    stream = sd.RawInputStream(
        samplerate=TARGET_RATE,
        channels=1,
        dtype="int16",
        blocksize=CHUNK_SAMPLES,
        callback=_cb,
    )
    with stream:
        dev = sd.query_devices(kind="input")["name"]
        print(f"  🎤 mic: {dev}   VAD threshold: {VAD_THRESHOLD:.0f}")
        print("  Speak your answers. Ctrl+C (or the agent's 'complete') ends it.\n")
        while not state.done:
            pcm = await q.get()
            now = time.perf_counter()
            if _rms_i16(pcm) > VAD_THRESHOLD:
                state.last_speech_at = now
                if state.turn_speech_start is None:
                    state.turn_speech_start = now
            await ws.send(pcm)


async def _stream_wav(ws, state: _State, source: str) -> None:
    """Stream a canned clip at real time, then trailing silence to flush the turn."""
    pcm = _load_16k_pcm(source)
    print(f"  streaming {len(pcm)} PCM bytes @16kHz in {CHUNK_MS} ms chunks, real time\n")
    for off in range(0, len(pcm), CHUNK_BYTES):
        chunk = pcm[off : off + CHUNK_BYTES]
        if _rms_i16(chunk) > VAD_THRESHOLD:
            state.last_speech_at = time.perf_counter()
            if state.turn_speech_start is None:
                state.turn_speech_start = time.perf_counter()
        await ws.send(chunk)
        await asyncio.sleep(CHUNK_MS / 1000.0)
    # Trailing silence so Flux can hit its end-of-turn timeout and finalize.
    for _ in range(int(3500 / CHUNK_MS)):
        if state.done:
            break
        await ws.send(_SILENCE)
        await asyncio.sleep(CHUNK_MS / 1000.0)


async def _receiver(ws, state: _State, recv_timeout: float) -> None:
    """Drain downstream frames, measuring each turn as it completes."""
    while not state.done:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=recv_timeout)
        except asyncio.TimeoutError:
            print(f"    (no frame for {recv_timeout:.0f}s — still listening)")
            continue
        now = time.perf_counter()

        if isinstance(raw, (bytes, bytearray)):
            cur = state.cur
            if cur is not None:
                if cur.get("first_pcm") is None:
                    cur["first_pcm"] = now
                cur["pcm_bytes"] = cur.get("pcm_bytes", 0) + len(raw)
            continue

        frame = json.loads(raw)
        ftype = frame.get("type")

        if ftype == "ready":
            print("    <- ready")
        elif ftype == "caption":
            if state.cur is not None:
                state.cur["captions"] = state.cur.get("captions", 0) + 1
                state.cur.setdefault("first_caption", now)
        elif ftype == "barge_in":
            print("    <- barge_in (agent playback cut)")
        elif ftype == "turn_final":
            # A new turn: anchor STT to the LOCAL speech-end we timestamped while
            # capturing, and snapshot the caption/speech-start markers for it.
            state.cur = {
                "t_final": now,
                "speech_end_local": state.last_speech_at,
                "speech_start_local": state.turn_speech_start,
            }
            state.turn_speech_start = None
            state.last_speech_at = None
            tx = frame.get("transcript", "")
            print(f"    <- turn_final: {tx[:80]!r}")
        elif ftype == "turn_result":
            if state.cur is not None:
                state.cur["t_result"] = now
            miss = frame.get("missing_signals")
            done = frame.get("is_complete")
            print(f"    <- turn_result: complete={done} missing={miss}")
        elif ftype == "speech_end":
            _finalize(state, at=now)
        elif ftype == "complete":
            print("    <- complete (member answered everything)")
            _finalize(state, at=now)
            state.done = True
            break
        elif ftype == "error":
            print(f"    <- error: {frame.get('message')!r}")


async def _run(args: argparse.Namespace) -> int:
    print("=" * 78)
    mode = "WAV" if args.wav is not None else "LIVE MIC"
    print(f"  Stage 5 — voice WebSocket, full chain ({mode})  STT -> analyze -> TTS")
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

    url = f"{WS_BASE}/api/v1/voice/session?session_id={SESSION_ID}&user_id={USER_ID}"
    print(f"  connecting: {url}")
    print(f"  session_id={SESSION_ID} user_id={USER_ID}  (must exist in the DB)")
    print(f"  Flux eot_timeout_ms (server): {settings.voice_eot_timeout_ms}\n")

    state = _State()
    try:
        async with websockets.connect(
            url, additional_headers={"X-Internal-Secret": settings.jwt_secret}
        ) as ws:
            # Mirror the browser: seed an (empty) fresh session before streaming.
            await ws.send(json.dumps({"type": "start", "conversation_history": []}))

            if args.wav is not None:
                source = args.wav or SAMPLE_URL
                sender = asyncio.create_task(_stream_wav(ws, state, source))
                recv_timeout = 30.0
            else:
                sender = asyncio.create_task(_capture_live(ws, state))
                recv_timeout = float(os.getenv("VOICE_PROBE_RECV_TIMEOUT", "120"))

            try:
                await _receiver(ws, state, recv_timeout)
            finally:
                state.done = True
                sender.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await sender
                with contextlib.suppress(Exception):
                    await ws.send(json.dumps({"type": "stop"}))
    except KeyboardInterrupt:
        print("\n  (stopped by Ctrl+C)")
    except Exception as exc:
        print(f"  ERROR: {type(exc).__name__}: {exc}")
        if not state.turns:
            return 1

    return _report(state)


def _report(state: _State) -> int:
    turns = state.turns
    print("\n  --- per-leg latency (across all measured turns) ---")
    stt = _vals(turns, "speech_end_local", "t_final")
    analyze = _vals(turns, "t_final", "t_result")
    ttfb = _vals(turns, "t_result", "first_pcm")
    reply = _vals(turns, "speech_end_local", "first_pcm")
    ttsdur = _vals(turns, "first_pcm", "t_speech_end")
    firstcap = _vals(turns, "speech_start_local", "first_caption")

    # STT perceived includes Flux's deliberate end-of-turn wait; subtract the
    # configured floor for a processing-only estimate (clamped at 0).
    eot = settings.voice_eot_timeout_ms
    stt_proc = [max(0.0, v - eot) for v in stt]

    print(_summary_row("STT endpoint (perceived, incl EOT)", stt))
    print(_summary_row(f"STT processing (minus {eot}ms EOT)", stt_proc))
    print(_summary_row("analyze (turn_final -> turn_result)", analyze))
    print(_summary_row("TTS TTFB (turn_result -> 1st PCM)", ttfb))
    print(_summary_row("TTS speech duration (1st PCM->end)", ttsdur))
    print(_summary_row("live-caption first byte (from speech)", firstcap))
    print(_summary_row("REPLY perceived (stop talk->hear)", reply))

    print("\n  --- VERDICT ---")
    if not turns:
        print("      NO TURNS MEASURED — check the mic/VAD threshold or the clip.")
        return 1
    # A turn is "full chain" if it hit turn_final, turn_result, and produced PCM.
    full = [
        t
        for t in turns
        if t.get("t_final") and t.get("t_result") and t.get("first_pcm")
    ]
    print(f"      turns measured : {len(turns)}")
    print(f"      full-chain turns: {len(full)} / {len(turns)}")
    ok = len(full) == len(turns) and len(turns) > 0
    print(f"      FULL CHAIN {'OK' if ok else 'INCOMPLETE'}")
    return 0 if ok else 1


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Voice WS latency probe (live mic default).")
    p.add_argument(
        "--wav",
        nargs="?",
        const="",
        default=None,
        metavar="PATH_OR_URL",
        help="Stream a canned WAV instead of the mic (offline/CI). Optional path/URL "
        "defaults to the spacewalk sample. Omit this flag for live-mic mode.",
    )
    p.add_argument(
        "--live",
        action="store_true",
        help="Force live-mic mode (the default when --wav is absent).",
    )
    return p.parse_args()


if __name__ == "__main__":
    _args = _parse_args()
    if _args.live and _args.wav is not None:
        raise SystemExit("Pass either --live or --wav, not both.")
    raise SystemExit(asyncio.run(_run(_args)))
