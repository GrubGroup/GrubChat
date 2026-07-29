"""Cartesia Sonic-3.5 text-to-speech relay.

The TTS leg of the voice I/O shell. It speaks the question the SERVER already
authored — ``conversation_agent`` composes the next question deterministically
from ``missing_signals`` — so the spoken wording is exact, never a model
paraphrase. Nothing here calls an LLM or rewrites text.

TWO TRANSPORTS, PICKED BY WHO IS LISTENING
------------------------------------------
``synthesize_bytes`` — one HTTP request, complete audio back. Simple, and the
right choice when the caller needs a whole clip (a file, a test, a short prompt).

``stream_audio`` — Server-Sent Events over HTTP, audio in chunks as they are
generated. This is what a live voice turn wants: playback can start at the first
chunk instead of waiting for the last, which is the difference between a ~300 ms
and a ~700 ms perceived response on a full sentence. Chosen over the WebSocket
transport deliberately — the WS API requires a ``context_id`` and is built for
multi-turn continuation, which buys nothing here because each question is an
independent utterance, and it would add a connection to manage per turn.

DOC-VERIFIED DETAILS
--------------------
  * REST/SSE auth is ``Authorization: Bearer`` — the ``X-API-Key`` header belongs
    to Cartesia's WebSocket API, not these endpoints.
  * ``Cartesia-Version`` is required. ``2026-03-01`` is current; older values are
    still accepted, so it is configurable rather than hardcoded.
  * ``max_buffer_delay_ms`` is **WebSocket-only**. The docs list it as a TTS
    request field without that restriction, but sending it to ``/tts/sse`` returns
    HTTP 400 "max buffer delay is only supported for websocket requests"
    (verified). It is therefore accepted here but never sent on the HTTP paths —
    see ``LOW_LATENCY_BUFFER_MS``.
  * Required fields are ``model_id``, ``transcript``, ``voice``, ``output_format``.
  * ``voice.mode`` accepts only ``"id"``.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
from collections.abc import AsyncIterator
from functools import lru_cache

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)

CARTESIA_BASE = "https://api.cartesia.ai"
SSE_URL = f"{CARTESIA_BASE}/tts/sse"
BYTES_URL = f"{CARTESIA_BASE}/tts/bytes"

# Resolved from settings so a deploy can pin a dated snapshot without a code edit.
# "sonic-3.5" is a FLOATING alias — Cartesia bumps the snapshot with no notice,
# drifting timbre/TTFB under the measured baseline — so settings.cartesia_model
# defaults to a dated pin. The voice id default is the scaffold's id, which is NOT
# the documented Skylar (db6b0ed5-…): verify it before a deploy (a stale id fails
# mid-turn as voice_not_found, silently). Kept as module constants for callers /
# probes that read them, but resolved lazily at call time via settings.
DEFAULT_MODEL = settings.cartesia_model
DEFAULT_VOICE_ID = settings.cartesia_voice_id


class ConcurrencyLimitError(RuntimeError):
    """Raised when Cartesia rejects a request with 429 concurrency_limited.

    Distinct from a generic HTTP error so the voice handler can degrade a single
    turn to text-only (speak nothing) instead of failing the whole connection.
    Cartesia bills TTS by concurrent /tts/sse contexts (2 Free / 3 Pro / 5 Startup
    / 15 Scale); a whole group finishing together can exceed the cap.
    """


# Process-wide gate on concurrent /tts/sse contexts. Bounded to the account tier's
# limit (settings.cartesia_max_concurrency) so overflow QUEUES here instead of
# earning a 429 from Cartesia. Lazily created so it binds to the running loop, not
# import time (the probe scripts use their own asyncio.run loop).
_tts_semaphore: asyncio.Semaphore | None = None


def _semaphore() -> asyncio.Semaphore:
    """Return the process-wide TTS concurrency gate, creating it on first use."""
    global _tts_semaphore
    if _tts_semaphore is None:
        _tts_semaphore = asyncio.Semaphore(max(1, settings.cartesia_max_concurrency))
    return _tts_semaphore

# Cartesia buffers up to `max_buffer_delay_ms` (default 3000 ms) before emitting,
# trading latency for smoother prosody — which would dominate the voice budget.
# But the knob exists ONLY on the WebSocket API: sending it to /tts/sse is a hard
# 400. Kept as the value to use IF this ever moves to the WS transport; the HTTP
# paths below deliberately omit it and appear not to buffer that way anyway
# (measured SSE TTFB is far below 3000 ms).
LOW_LATENCY_BUFFER_MS = 120

# 44.1 kHz float PCM in a WAV container for the one-shot path (browser-playable
# as-is). The streaming path defaults to raw PCM: a WAV header declares a length
# up front, which is meaningless for an open-ended stream.
WAV_OUTPUT = {"container": "wav", "encoding": "pcm_f32le", "sample_rate": 44100}
RAW_OUTPUT = {"container": "raw", "encoding": "pcm_f32le", "sample_rate": 44100}


@lru_cache(maxsize=1)
def _client() -> httpx.AsyncClient:
    """A process-wide client so the TLS handshake is paid once, not per turn.

    Measured: reusing the connection cut streaming TTFB from ~321 ms to ~247 ms
    p50. A fresh AsyncClient per utterance re-does TCP+TLS (~55 ms to Cartesia)
    on every question the agent asks, which is pure waste in a voice loop.
    """
    return httpx.AsyncClient(
        timeout=httpx.Timeout(30.0, connect=10.0),
        limits=httpx.Limits(max_keepalive_connections=4, keepalive_expiry=300.0),
    )


def _headers() -> dict[str, str]:
    """Auth + version headers for the REST/SSE endpoints."""
    if not settings.cartesia_api_key:
        raise RuntimeError("CARTESIA_API_KEY is not set — cannot synthesize speech.")
    return {
        # Bearer, NOT X-API-Key: that one is the WebSocket API's scheme.
        "Authorization": f"Bearer {settings.cartesia_api_key}",
        "Cartesia-Version": settings.cartesia_version,
        "Content-Type": "application/json",
    }


def _payload(
    text: str,
    *,
    model: str,
    voice_id: str,
    output_format: dict,
) -> dict:
    """Build a TTS request body for the HTTP (SSE / bytes) endpoints.

    Deliberately omits ``max_buffer_delay_ms``: it is a WebSocket-only field and
    including it makes these endpoints return 400.
    """
    return {
        "model_id": model,
        "transcript": text,
        "voice": {"mode": "id", "id": voice_id},  # "id" is the only allowed mode
        "output_format": output_format,
    }


async def _raise_with_body(response: httpx.Response) -> None:
    """raise_for_status, but read the body first so the reason is visible.

    Cartesia explains rejections in the response body ("max buffer delay is only
    supported for websocket requests"); a bare raise_for_status on a STREAMED
    response discards that and leaves only "400 Bad Request". A 429 is surfaced as
    ConcurrencyLimitError so the caller can degrade one turn to text-only rather
    than tearing down the whole voice connection.
    """
    if response.is_error:
        await response.aread()
        detail = response.text[:300]
        logger.error("Cartesia %s: %s", response.status_code, detail)
        if response.status_code == 429:
            raise ConcurrencyLimitError(
                f"Cartesia concurrency limit hit: {detail}"
            )
        raise httpx.HTTPStatusError(
            f"Cartesia returned {response.status_code}: {detail}",
            request=response.request,
            response=response,
        )


async def synthesize_bytes(
    text: str,
    *,
    model: str = DEFAULT_MODEL,
    voice_id: str = DEFAULT_VOICE_ID,
    output_format: dict | None = None,
    timeout: float = 30.0,
) -> bytes:
    """Synthesize `text` in one request and return the complete audio.

    Use for a whole clip; prefer ``stream_audio`` inside a live turn so playback
    can begin before generation finishes.
    """
    response = await _client().post(
        BYTES_URL,
        headers=_headers(),
        json=_payload(
            text,
            model=model,
            voice_id=voice_id,
            output_format=output_format or WAV_OUTPUT,
        ),
        timeout=timeout,
    )
    if response.is_error:
        logger.error("Cartesia %s: %s", response.status_code, response.text[:300])
    response.raise_for_status()
    return response.content


async def stream_audio(
    text: str,
    *,
    model: str = DEFAULT_MODEL,
    voice_id: str = DEFAULT_VOICE_ID,
    output_format: dict | None = None,
    timeout: float = 30.0,
    max_retries: int = 2,
) -> AsyncIterator[bytes]:
    """Stream synthesized audio for `text`, yielding raw PCM chunks as they arrive.

    Yields decoded audio bytes (not SSE frames) so a caller can pipe them straight
    to a player or a socket. Cartesia sends base64 chunks in an SSE ``data:``
    field; NON-audio frames are handled by ``type``:

      * ``chunk`` (or any frame carrying ``data``) — decode and yield.
      * ``done`` — the REAL terminal sentinel is ``{"type":"done","done":true}``,
        NOT the ``[DONE]`` the old docstring claimed (that survived only by
        accident: no ``data`` key → skipped). Break cleanly on it.
      * ``error`` — a stream-ending error frame; log and stop rather than spin.

    A chunk that fails to base64-decode is logged and dropped rather than aborting
    the utterance — losing one chunk degrades audio, but raising would cut the
    question off mid-sentence.

    CONCURRENCY: the whole stream is held under a process-wide semaphore bounded to
    the Cartesia tier's concurrent-context limit, so a group finishing together
    QUEUES here instead of drawing a 429. If Cartesia still returns 429
    (another instance, or a misconfigured limit), retry with a short backoff up to
    ``max_retries``, then raise ``ConcurrencyLimitError`` for the caller to degrade
    to text-only. Retries are safe only because a 429 arrives BEFORE any audio byte
    is yielded (it's a connect-time rejection).
    """
    payload = _payload(
        text,
        model=model,
        voice_id=voice_id,
        output_format=output_format or RAW_OUTPUT,
    )
    async with _semaphore():
        for attempt in range(max_retries + 1):
            try:
                async for chunk in _stream_once(payload, timeout=timeout):
                    yield chunk
                return
            except ConcurrencyLimitError:
                if attempt >= max_retries:
                    raise
                # Short backoff; a context frees the moment another utterance ends.
                await asyncio.sleep(0.25 * (attempt + 1))


async def _stream_once(payload: dict, *, timeout: float) -> AsyncIterator[bytes]:
    """One /tts/sse attempt: yield decoded PCM until the ``done`` frame or EOF."""
    async with _client().stream(
        "POST",
        SSE_URL,
        headers=_headers(),
        json=payload,
        timeout=timeout,
    ) as response:
        await _raise_with_body(response)  # 429 -> ConcurrencyLimitError (pre-yield)
        async for line in response.aiter_lines():
            if not line or not line.startswith("data:"):
                continue
            raw = line[len("data:") :].strip()
            if not raw:
                continue
            try:
                event = json.loads(raw)
            except (TypeError, ValueError):
                continue
            etype = event.get("type")
            if etype == "done":
                break
            if etype == "error":
                logger.error("Cartesia TTS error frame: %s", event)
                break
            chunk = event.get("data")
            if not chunk:
                continue
            try:
                yield base64.b64decode(chunk)
            except Exception as exc:
                logger.warning("skipping undecodable TTS chunk: %s", exc)
