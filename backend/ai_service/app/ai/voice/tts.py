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

DEFAULT_MODEL = "sonic-3.5"
# A neutral, friendly English voice ("Skylar - Friendly Guide", public). Override
# per call once the product picks an agent voice.
DEFAULT_VOICE_ID = "694f9389-aac1-45b6-b726-9d9369183238"

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
    response discards that and leaves only "400 Bad Request".
    """
    if response.is_error:
        await response.aread()
        detail = response.text[:300]
        logger.error("Cartesia %s: %s", response.status_code, detail)
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
) -> AsyncIterator[bytes]:
    """Stream synthesized audio for `text`, yielding raw PCM chunks as they arrive.

    Yields decoded audio bytes (not SSE frames) so a caller can pipe them straight
    to a player or a socket. Cartesia sends base64 chunks in an SSE ``data:``
    field; the terminal ``[DONE]`` sentinel and any non-audio frame are skipped.
    A frame that fails to decode is logged and dropped rather than aborting the
    utterance — losing one chunk degrades audio, but raising would cut the
    question off mid-sentence.
    """
    async with _client().stream(
        "POST",
        SSE_URL,
        headers=_headers(),
        json=_payload(
            text,
            model=model,
            voice_id=voice_id,
            output_format=output_format or RAW_OUTPUT,
        ),
        timeout=timeout,
    ) as response:
        await _raise_with_body(response)
        async for line in response.aiter_lines():
            if not line or not line.startswith("data:"):
                continue
            raw = line[len("data:") :].strip()
            if not raw or raw == "[DONE]":
                continue
            try:
                event = json.loads(raw)
            except (TypeError, ValueError):
                continue
            if event.get("type") == "error":
                logger.error("Cartesia TTS error frame: %s", event)
                continue
            chunk = event.get("data")
            if not chunk:
                continue
            try:
                yield base64.b64decode(chunk)
            except Exception as exc:
                logger.warning("skipping undecodable TTS chunk: %s", exc)
