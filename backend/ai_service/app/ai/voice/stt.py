"""Deepgram Flux streaming speech-to-text relay.

The STT leg of the voice I/O shell: audio in, finalized user turns out. The
transcript then goes to the existing text ``/analyze`` agent, which remains the
sole structured-extraction authority — nothing here parses preferences.

WHY FLUX, AND WHAT IT CHANGES
-----------------------------
Flux does turn detection server-side, so this relay does not implement VAD. It
emits a single ``TurnInfo`` message type whose ``event`` field carries the state:

  * ``StartOfTurn``    — the user began speaking. Barge-in signal: if TTS is
    playing, stop it.
  * ``Update``         — interim words. Useful for a live caption; never sent to
    ``/analyze`` (a partial turn would be parsed as a complete answer).
  * ``EagerEndOfTurn`` — a speculative end, ahead of the confirmed one.
    Deliberately NOT acted on here (see below).
  * ``TurnResumed``    — the eager guess was wrong; the user kept talking.
  * ``EndOfTurn``      — confirmed. THIS is what dispatches to ``/analyze``.

The loop is intentionally ``EndOfTurn``-driven only. ``EagerEndOfTurn`` enables
speculative dispatch (start the LLM call early, discard on ``TurnResumed``) which
can hide much of the LLM latency — but it doubles LLM spend on false eagers and
needs cancellation plumbing, so it is a later, separately-designed step. The
event is surfaced in the yielded payload, so that work needs no protocol change.

DOC-VERIFIED DETAILS THAT DIFFER FROM THE OBVIOUS GUESS
------------------------------------------------------
  * Endpoint is ``/v2/listen`` — ``/v1/listen`` does NOT serve Flux.
  * ``model`` is REQUIRED; omitting it does not default to Flux.
  * Auth scheme is ``Token``, not ``Bearer``.
  * The close frame's wire value is ``CloseStream`` (one word), even though the
    doc page is titled "Close Stream".
  * As a query param the biasing key is singular ``keyterm``, repeated once per
    term (the JSON ``Configure`` message uses plural ``keyterms``).

``EndOfTurn`` IS NOT GUARANTEED — plan for its absence
------------------------------------------------------
A session can end having produced only ``Update`` frames. Measured: one sample
clip yielded 145 ``Update``s, ``StartOfTurn``, and **no** ``EndOfTurn``; adding
1 s of trailing silence did not change that, and only a ~6 s tail (past the
``eot_timeout_ms`` default of 5000) finalized it. Sending ``CloseStream`` did NOT
force a final either.

So a consumer that only acts on ``event.is_final`` can silently drop a user's
whole answer. Callers must keep the last non-empty transcript and fall back to it
when the stream ends without a final — ``consume_turns`` below does exactly that,
and is the recommended entry point for that reason. Lowering
``eot_timeout_ms`` (range 500-60000) makes finalization more eager and is worth
tuning for short question-answer turns, where the 5 s default is far too patient.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from urllib.parse import urlencode

import websockets

from app.core.config import settings

logger = logging.getLogger(__name__)

FLUX_URL = "wss://api.deepgram.com/v2/listen"
DEFAULT_MODEL = "flux-general-en"
# linear16 @ 16 kHz mono: what a browser AudioWorklet yields after downsampling,
# and a documented Flux encoding.
DEFAULT_ENCODING = "linear16"
DEFAULT_SAMPLE_RATE = 16_000
# Wire value is one word — "Close Stream" would be rejected.
CLOSE_FRAME = json.dumps({"type": "CloseStream"})


@dataclass(slots=True)
class TurnEvent:
    """One Flux ``TurnInfo`` message, normalized for callers.

    ``transcript`` is the turn's text so far; on ``EndOfTurn`` it is the final
    text to send to ``/analyze``. ``is_final`` marks exactly that case so callers
    never have to remember which event names are terminal.
    """

    event: str
    transcript: str
    turn_index: int | None = None
    end_of_turn_confidence: float | None = None
    raw: dict = field(default_factory=dict, repr=False)

    @property
    def is_final(self) -> bool:
        """True only for a confirmed end of turn — the dispatch trigger."""
        return self.event == "EndOfTurn"

    @property
    def is_barge_in(self) -> bool:
        """True when the user started talking (stop any playing TTS)."""
        return self.event == "StartOfTurn"


def build_flux_url(
    *,
    model: str = DEFAULT_MODEL,
    encoding: str = DEFAULT_ENCODING,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    keyterms: list[str] | None = None,
    eot_threshold: float | None = None,
    eot_timeout_ms: int | None = None,
    eager_eot_threshold: float | None = None,
) -> str:
    """Build the Flux WebSocket URL.

    ``keyterms`` is passed as a REPEATED singular ``keyterm`` param — the plural
    form belongs to the JSON ``Configure`` message, not the query string.

    ``eager_eot_threshold`` (0.3-0.9, must be <= ``eot_threshold``) OPTS IN to
    ``EagerEndOfTurn`` events. Flux does not emit them otherwise — a session
    without this parameter sees only StartOfTurn/Update/EndOfTurn. Enabling it
    changes nothing about when ``EndOfTurn`` arrives; it only adds an earlier,
    retractable guess (retracted by ``TurnResumed``), which is what a speculative
    dispatch would key on.
    """
    params: list[tuple[str, str]] = [
        ("model", model),  # required — no Flux default
        ("encoding", encoding),
        ("sample_rate", str(sample_rate)),
    ]
    if eot_threshold is not None:
        params.append(("eot_threshold", str(eot_threshold)))
    if eot_timeout_ms is not None:
        params.append(("eot_timeout_ms", str(eot_timeout_ms)))
    if eager_eot_threshold is not None:
        params.append(("eager_eot_threshold", str(eager_eot_threshold)))
    for term in keyterms or []:
        params.append(("keyterm", term))
    return f"{FLUX_URL}?{urlencode(params)}"


def _parse_turn(payload: dict) -> TurnEvent | None:
    """Normalize a raw Flux message into a TurnEvent, or None if not a turn.

    The transcript is read from the top level or from a nested ``turn`` object,
    falling back to joining ``words`` — the shape varies by event, and a missing
    transcript would silently drop a user's answer. Non-``TurnInfo`` frames
    (``Connected``, ``Error``, keepalives) yield None for the caller to handle.
    """
    if payload.get("type") != "TurnInfo":
        return None

    turn = payload.get("turn") if isinstance(payload.get("turn"), dict) else {}
    transcript = (
        payload.get("transcript")
        or turn.get("transcript")
        or " ".join(
            word.get("word", "")
            for word in (payload.get("words") or turn.get("words") or [])
            if isinstance(word, dict)
        )
    ).strip()

    return TurnEvent(
        event=str(payload.get("event") or ""),
        transcript=transcript,
        turn_index=payload.get("turn_index") or turn.get("turn_index"),
        end_of_turn_confidence=(
            payload.get("end_of_turn_confidence")
            or turn.get("end_of_turn_confidence")
        ),
        raw=payload,
    )


async def stream_transcription(
    audio: AsyncIterator[bytes],
    *,
    keyterms: list[str] | None = None,
    model: str = DEFAULT_MODEL,
    encoding: str = DEFAULT_ENCODING,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    eot_threshold: float | None = None,
    eot_timeout_ms: int | None = None,
    eager_eot_threshold: float | None = None,
    on_event: Callable[[TurnEvent], Awaitable[None]] | None = None,
) -> AsyncIterator[TurnEvent]:
    """Stream `audio` chunks to Flux and yield TurnEvents as they arrive.

    Yields EVERY turn event, not just finals, so one caller can drive a live
    caption and handle barge-in; filter on ``event.is_final`` for the dispatch
    trigger. ``on_event`` is an optional side-channel hook (e.g. relaying to
    Socket.IO) invoked before each yield.

    Sender and receiver run concurrently: audio upload must not block on reading
    results, or a slow consumer would stall the mic.
    """
    if not settings.deepgram_api_key:
        raise RuntimeError("DEEPGRAM_API_KEY is not set — cannot open a Flux session.")

    url = build_flux_url(
        model=model,
        encoding=encoding,
        sample_rate=sample_rate,
        keyterms=keyterms,
        eot_threshold=eot_threshold,
        eot_timeout_ms=eot_timeout_ms,
        eager_eot_threshold=eager_eot_threshold,
    )
    # "Token", not "Bearer" — Deepgram's documented scheme.
    headers = {"Authorization": f"Token {settings.deepgram_api_key}"}

    async with websockets.connect(url, additional_headers=headers) as ws:
        queue: asyncio.Queue[TurnEvent | None] = asyncio.Queue()

        async def _send() -> None:
            """Pump mic audio upstream, then half-close so Flux flushes the tail."""
            try:
                async for chunk in audio:
                    if chunk:
                        await ws.send(chunk)
            except Exception as exc:
                logger.warning("STT audio sender stopped: %s", exc)
            finally:
                # CloseStream tells Flux to finalize the in-flight turn rather than
                # drop it — without this a trailing word can be lost.
                try:
                    await ws.send(CLOSE_FRAME)
                except Exception:
                    pass

        async def _recv() -> None:
            """Read Flux frames, normalize them, and hand them to the consumer."""
            try:
                async for message in ws:
                    try:
                        payload = json.loads(message)
                    except (TypeError, ValueError):
                        continue
                    if payload.get("type") == "Error":
                        logger.error("Flux error frame: %s", payload)
                        continue
                    event = _parse_turn(payload)
                    if event is not None:
                        await queue.put(event)
            except websockets.ConnectionClosed:
                pass
            except Exception as exc:
                logger.warning("STT receiver stopped: %s", exc)
            finally:
                await queue.put(None)  # sentinel: no more events

        sender = asyncio.create_task(_send())
        receiver = asyncio.create_task(_recv())
        try:
            while True:
                event = await queue.get()
                if event is None:
                    break
                if on_event is not None:
                    await on_event(event)
                yield event
        finally:
            for task in (sender, receiver):
                if not task.done():
                    task.cancel()


async def consume_turns(
    audio: AsyncIterator[bytes],
    **kwargs,
) -> AsyncIterator[str]:
    """Yield COMPLETE user turns as text — the safe entry point for /analyze.

    Wraps ``stream_transcription`` with the one guarantee callers actually need:
    **no answer is dropped**. It yields on every ``EndOfTurn``, and if the stream
    ends without one, it yields the last non-empty interim transcript instead.

    That fallback is not defensive padding — ``EndOfTurn`` genuinely does not
    always arrive (see the module docstring: a real clip produced 145 interims and
    no final). Filtering on ``is_final`` alone would have discarded that entire
    turn, so a member would have spoken and had nothing recorded.

    Accepts the same keyword arguments as ``stream_transcription``.

    IMPORTANT — ``Update`` transcripts are NOT cumulative. Measured on one clip:
    59 non-empty interims whose lengths rose and fell (max 14 chars, last 5), with
    the final interim being ``"wife."`` — a fragment, not the turn. So the fallback
    ACCUMULATES fragments rather than keeping the latest one; keeping the latest
    would silently truncate a whole answer down to its last word. Fragments are
    de-duplicated because Flux revises a fragment in place as it refines it, which
    would otherwise repeat words.
    """
    fragments: list[str] = []

    def _collect(text: str) -> None:
        """Append a fragment unless it merely revises the previous one."""
        clean = text.strip()
        if not clean:
            return
        if fragments:
            last = fragments[-1]
            # A revision of the same fragment (either direction) replaces it.
            if clean.startswith(last) or last.startswith(clean):
                fragments[-1] = clean if len(clean) >= len(last) else last
                return
        fragments.append(clean)

    async for event in stream_transcription(audio, **kwargs):
        if event.is_final:
            # A final carries the authoritative text for its turn when present.
            text = event.transcript.strip() or " ".join(fragments).strip()
            if text:
                yield text
            fragments.clear()
        elif event.transcript:
            _collect(event.transcript)

    # Stream ended with an unfinalized turn — do not lose what was said.
    leftover = " ".join(fragments).strip()
    if leftover:
        logger.info(
            "stream ended without EndOfTurn; recovered %d interim fragment(s)",
            len(fragments),
        )
        yield leftover
