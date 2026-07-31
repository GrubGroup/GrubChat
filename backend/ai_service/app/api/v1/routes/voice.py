"""Voice relay WebSocket: mic audio -> Flux STT -> /analyze -> Cartesia TTS.

This is the ai_service end of the cascaded voice I/O shell. The gateway opens ONE
authenticated WebSocket per member voice turn-loop and relays:

  * upstream: binary mic audio (16 kHz linear16) + JSON control frames
    (``start`` / ``mute`` / ``stop``);
  * downstream: JSON control frames (``ready`` / ``caption`` / ``barge_in`` /
    ``turn_final`` / ``turn_result`` / ``speech_end`` / ``complete`` / ``error``)
    interleaved with binary TTS audio (44.1 kHz pcm_f32le).

It reuses the measured Python legs unchanged: ``stt.consume_turns`` (server-side
endpointing, interim captions + barge-in via its ``on_event`` hook),
``session_service.analyze_member_turn`` (the SAME structured-extraction authority
the text path uses — so ``/analyze`` stays the only Qa writer, invariant #3), and
``tts.stream_audio`` (SSE PCM with a concurrency gate).

Key correctness properties (all learned in the hardening pass):

  * AUTH reuses ``require_internal_secret`` as a pre-accept ``Depends`` — on a WS
    route an ``HTTPException`` raised before ``accept()`` becomes a real HTTP 401
    handshake denial (cleaner to debug than an opaque close code). Never raise
    ``HTTPException`` after ``accept()``.
  * TURNS ARE SERIALIZED per connection behind an ``asyncio.Lock``: analyze + its
    Qa write is an unlocked read-then-write, and two in-flight turns for one
    (session, user) race (lost write, or a duplicate-INSERT 500). One turn commits
    before the next starts.
  * BARGE-IN cancels only the in-flight TTS task, never analyze — a Qa write is
    never torn in half.
  * MUTE streams SILENCE, it does not pause the pump: Flux closes an idle socket
    after ~60s and accepts no keepalive.
  * The spoken confirm is VOICE-SHAPED (this turn's delta only), not the text
    path's full-recap ``_fallback_reply``.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends, Query, WebSocket, WebSocketDisconnect

from app.ai.agents.conversation_agent import _QUESTION_FOR
from app.ai.voice.keyterms import get_keyterms
from app.ai.voice.stt import TurnEvent, consume_turns
from app.ai.voice.tts import ConcurrencyLimitError, stream_audio
from app.ai.voice.voices import resolve_voice_id
from app.api.deps import require_internal_secret
from app.core.config import settings
from app.schemas.ai import AnalyzeRequest, ConversationTurn, ExtractedSignals
from app.schemas.voice import (
    BargeInFrame,
    CaptionFrame,
    CompleteFrame,
    ErrorFrame,
    ReadyFrame,
    SpeechEndFrame,
    TurnFinalFrame,
    TurnResultFrame,
)
from app.services import session_service

logger = logging.getLogger(__name__)

router = APIRouter(tags=["voice"])

# 16 kHz mono linear16 = 32000 bytes/s. One 80 ms silence frame (Deepgram's
# recommended chunk) keeps a muted mic's Flux socket alive under its ~60s idle cap.
_SILENCE_FRAME = b"\x00" * (16_000 * 2 * 80 // 1000)
_SILENCE_INTERVAL_S = 0.08

# Re-ask the same question at most this many times before advancing, so a
# repeatedly-degraded turn (LLM failing on a "nothing to avoid" answer) can't loop
# the member on one question forever.
_MAX_REASK = 2

# Refuse a second concurrent connection for the same (session, user): a duplicate
# open mic double-bills Deepgram and races two turn loops onto one Qa row.
_active: set[tuple[int, int]] = set()


class _VoiceConnection:
    """Owns one member's voice turn-loop: STT -> analyze -> TTS over one socket.

    Holds the per-connection turn lock, the current TTS task (for barge-in
    cancellation), the seeded chat context (for mixed typed+voice coherence), and
    the mute flag. One instance per accepted WebSocket.
    """

    def __init__(self, ws: WebSocket, *, session_id: int, user_id: int) -> None:
        self.ws = ws
        self.session_id = session_id
        self.user_id = user_id
        # Serializes analyze + Qa write: one turn commits before the next starts.
        self._turn_lock = asyncio.Lock()
        # The in-flight TTS streaming task, so barge-in can cancel JUST speech.
        self._tts_task: asyncio.Task | None = None
        # Seeded from the client's `start` frame; kept current across turns so the
        # analyze context matches what the text chat already tracks.
        self._history: list[ConversationTurn] = []
        self._signals = ExtractedSignals()
        # The Cartesia voice this member picked (settings dropdown), seeded from
        # the `start` frame and validated against the allowlist. Defaults to the
        # configured server voice until a `start` frame supplies one.
        self._voice_id: str = resolve_voice_id(None)
        # Per-signal re-ask counter, so a degraded turn can't loop forever.
        self._last_missing: str | None = None
        self._reask_count = 0
        # Mute: while set, audio_iter yields silence instead of real mic bytes.
        self._muted = False
        # Bounded queue of upstream mic chunks feeding consume_turns.
        self._audio_q: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=256)
        self._closed = False
        self._last_voice_at = time.monotonic()

    # -- upstream: read gateway frames, split control vs audio -----------------

    async def pump(self) -> None:
        """Read frames off the socket: binary -> audio queue, text -> control.

        Runs until the socket closes or a ``stop`` frame arrives. On exit it pushes
        the ``None`` sentinel so ``audio_iter`` (and thus ``consume_turns``) ends.
        """
        try:
            while True:
                message = await self.ws.receive()
                if message.get("type") == "websocket.disconnect":
                    break
                data = message.get("bytes")
                if data is not None:
                    self._last_voice_at = time.monotonic()
                    # Drop the oldest chunk rather than block the socket read if a
                    # slow Flux upload backs the queue up (bounded memory).
                    if self._audio_q.full():
                        with contextlib.suppress(asyncio.QueueEmpty):
                            self._audio_q.get_nowait()
                    self._audio_q.put_nowait(data)
                    continue
                text = message.get("text")
                if text is not None and not await self._handle_control(text):
                    break  # a `stop` frame
        except WebSocketDisconnect:
            pass
        except Exception as exc:  # never let a pump crash leak the Flux socket
            logger.warning("voice pump stopped: %s", exc)
        finally:
            self._closed = True
            with contextlib.suppress(Exception):
                self._audio_q.put_nowait(None)

    async def _handle_control(self, text: str) -> bool:
        """Apply one JSON control frame. Returns False on ``stop`` (end the loop)."""
        try:
            frame = json.loads(text)
        except (TypeError, ValueError):
            return True
        ftype = frame.get("type")
        if ftype == "stop":
            return False
        if ftype == "mute":
            self._muted = bool(frame.get("muted"))
        elif ftype == "start":
            # Re-seed the analyze context from the client's current chat state.
            history = frame.get("conversation_history") or []
            self._history = [
                ConversationTurn(**t)
                for t in history
                if isinstance(t, dict) and t.get("role") and t.get("content")
            ]
            sig = frame.get("current_signals")
            if isinstance(sig, dict):
                with contextlib.suppress(Exception):
                    self._signals = ExtractedSignals(**sig)
            # Validate the requested voice against the allowlist; an unknown value
            # falls back to the server default rather than reaching Cartesia raw.
            self._voice_id = resolve_voice_id(frame.get("voice_id"))
        return True

    async def audio_iter(self) -> AsyncIterator[bytes]:
        """Drain the mic queue for ``consume_turns``; yield silence while muted.

        While muted we still emit zeroed frames so Flux's ~60s idle timeout (no
        keepalive message exists on /v2/listen) never closes the stream mid-session.
        """
        while not self._closed:
            if self._muted:
                yield _SILENCE_FRAME
                await asyncio.sleep(_SILENCE_INTERVAL_S)
                continue
            try:
                chunk = await asyncio.wait_for(
                    self._audio_q.get(), timeout=_SILENCE_INTERVAL_S
                )
            except asyncio.TimeoutError:
                # No mic bytes this tick: keep the socket warm with one silence
                # frame rather than going quiet toward the idle cap.
                yield _SILENCE_FRAME
                continue
            if chunk is None:
                return
            yield chunk

    # -- downstream: relay Flux events as captions / barge-in ------------------

    async def relay_event(self, event: TurnEvent) -> None:
        """``on_event`` hook: forward interim captions + barge-in to the client."""
        if event.is_barge_in:
            self._cancel_tts()
            await self._send(BargeInFrame())
        elif event.transcript and not event.is_final:
            await self._send(CaptionFrame(text=event.transcript, is_final=False))

    # -- the turn loop ---------------------------------------------------------

    async def run(self) -> None:
        """Drive the STT->analyze->TTS loop until the member is done or the socket
        closes.

        STT consumption and turn handling run as TWO concurrent tasks, on purpose.
        ``on_event`` (barge-in / captions) only fires while ``consume_turns`` is
        being iterated — so if the SAME coroutine both iterated it AND blocked on
        ``_speak`` awaiting the full TTS stream, a mid-playback ``StartOfTurn``
        would never reach ``relay_event`` and barge-in would silently never cancel
        TTS. Instead an STT task keeps pumping events (relaying barge-in the moment
        it arrives) and queues finalized transcripts; the handler loop drains that
        queue one turn at a time (serializing analyze+persist).
        """
        keyterms = await get_keyterms()
        await self._send(ReadyFrame())
        turn_q: asyncio.Queue[str | None] = asyncio.Queue()

        async def _stt_loop() -> None:
            try:
                async for transcript in consume_turns(
                    self.audio_iter(),
                    keyterms=keyterms,
                    eot_timeout_ms=settings.voice_eot_timeout_ms,
                    on_event=self.relay_event,
                ):
                    clean = transcript.strip()
                    if clean:
                        await turn_q.put(clean)
            except Exception as exc:  # a dead STT stream must end the loop, not hang
                logger.warning("voice STT loop stopped: %s", exc)
            finally:
                await turn_q.put(None)

        stt_task = asyncio.create_task(_stt_loop())
        try:
            while True:
                transcript = await turn_q.get()
                if transcript is None:
                    break
                await self._send(CaptionFrame(text=transcript, is_final=True))
                await self._send(TurnFinalFrame(transcript=transcript))
                done = await self._handle_turn(transcript)
                if done:
                    await self._send(CompleteFrame())
                    break
        finally:
            stt_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await stt_task

    async def _handle_turn(self, transcript: str) -> bool:
        """Analyze one finalized turn, speak the reply, update state.

        Returns True when the member has answered everything (loop may stop). The
        analyze + Qa write runs under the per-connection lock so overlapping turns
        never race the unlocked Qa upsert.
        """
        async with self._turn_lock:
            self._history.append(ConversationTurn(role="user", content=transcript))
            payload = AnalyzeRequest(
                user_id=self.user_id,
                message=transcript,
                message_source="voice",
                conversation_history=self._history[:-1],
                current_signals=self._signals,
            )
            try:
                result = await session_service.analyze_member_turn(
                    payload, session_id=self.session_id
                )
            except Exception as exc:
                logger.warning("voice analyze failed: %s", exc)
                await self._send(ErrorFrame(message="Sorry, I didn't catch that."))
                return False

            signals: ExtractedSignals = result["extracted_signals"]
            missing: list[str] = list(result.get("missing_signals") or [])
            reply: str = result.get("agent_reply") or ""
            degraded: bool = bool(result.get("degraded"))
            self._signals = signals
            self._history.append(
                ConversationTurn(role="assistant", content=reply)
            )

            # A degraded turn (LLM unusable) came back with the PRIOR signals and a
            # safe fallback reply. The frontend derives completion from missing==[],
            # but we must NOT auto-complete on a degraded turn — its missing list is
            # the deterministic recompute, which can read empty spuriously. Keep the
            # loop going and re-ask (bounded by _MAX_REASK below).
            complete = (not missing) and not degraded
            spoken = _voice_confirm(signals, missing, reply)
            await self._send(
                TurnResultFrame(
                    extracted_signals=signals,
                    missing_signals=missing,
                    agent_reply=reply,
                    is_complete=complete,
                    degraded=degraded,
                )
            )
            await self._speak(spoken)

            if complete:
                return True
            if not missing:
                # Degraded turn with an empty missing list: re-ask the last known
                # question rather than ending or asking nothing.
                missing = [self._last_missing] if self._last_missing else []
                if not missing:
                    return False
            # Re-ask cap: if we keep asking the same first-missing signal, advance
            # after _MAX_REASK so a persistently-degraded turn can't trap the member.
            head = missing[0]
            if head == self._last_missing:
                self._reask_count += 1
                if self._reask_count > _MAX_REASK:
                    logger.info("voice loop advancing past stuck signal %s", head)
                    return True
            else:
                self._last_missing = head
                self._reask_count = 0
            return False

    # -- TTS -------------------------------------------------------------------

    async def _speak(self, text: str) -> None:
        """Stream the spoken reply as downstream binary PCM (cancellable)."""
        if not text.strip():
            return
        self._cancel_tts()
        self._tts_task = asyncio.create_task(self._stream_tts(text))
        with contextlib.suppress(asyncio.CancelledError):
            await self._tts_task

    async def _stream_tts(self, text: str) -> None:
        """Pipe Cartesia PCM to the client; degrade to text-only on 429."""
        try:
            async for pcm in stream_audio(
                text,
                model=settings.cartesia_model,
                voice_id=self._voice_id,
            ):
                await self.ws.send_bytes(pcm)
            await self._send(SpeechEndFrame())
        except ConcurrencyLimitError:
            logger.warning("Cartesia concurrency exhausted; turn stays text-only")
            await self._send(ErrorFrame(message="voice busy — showing text only"))
        except asyncio.CancelledError:
            raise  # barge-in: caller cancelled; let it propagate
        except Exception as exc:
            logger.warning("voice TTS stream failed: %s", exc)
            await self._send(ErrorFrame(message="voice playback failed"))

    def _cancel_tts(self) -> None:
        """Cancel any in-flight TTS (barge-in). Analyze is never cancelled here."""
        if self._tts_task is not None and not self._tts_task.done():
            self._tts_task.cancel()
        self._tts_task = None

    # -- helpers ---------------------------------------------------------------

    async def _send(self, frame) -> None:
        """Send a control frame as JSON text, swallowing a closed-socket error."""
        with contextlib.suppress(Exception):
            await self.ws.send_text(frame.model_dump_json())

    def idle_seconds(self) -> float:
        return time.monotonic() - self._last_voice_at


def _voice_confirm(
    signals: ExtractedSignals, missing: list[str], reply: str
) -> str:
    """A short, TTS-shaped confirm-then-ask for THIS turn — not the full recap.

    The text path's ``_fallback_reply`` re-states the entire accumulated signal set
    every turn and renders long lists as "thai, ramen, sushi, chinese, +16 more" —
    Cartesia would literally speak "plus sixteen more," and by turn 4 the preamble
    is a paragraph. Here we prefer the server-authored ``reply`` when it is already
    short, else fall back to just asking the next question, so spoken turns stay
    tight. (The full reply still goes to the chat transcript via ``turn_result``.)
    """
    if missing:
        return _QUESTION_FOR.get(missing[0], reply or "What else matters to you?")
    return "Great — that's everything I need. Thanks!"


@router.websocket("/voice/session")
async def voice_session(
    websocket: WebSocket,
    session_id: int = Query(...),
    user_id: int = Query(...),
    _guard: None = Depends(require_internal_secret),
) -> None:
    """Bidirectional voice relay for one member's QA turn-loop.

    ``require_internal_secret`` runs as a PRE-ACCEPT dependency: a bad/missing
    ``X-Internal-Secret`` raises HTTPException(401) before the handshake completes,
    producing a real 401 rather than an opaque close. The gateway is the only
    caller and forwards the (server-verified) ``user_id`` — never a client value.
    """
    key = (session_id, user_id)
    if key in _active:
        # A second concurrent mic for the same member would double-bill Deepgram
        # and race two loops onto one Qa row. Refuse before accepting.
        await websocket.accept()
        await websocket.send_text(
            ErrorFrame(message="a voice session is already active").model_dump_json()
        )
        await websocket.close(code=1008)
        return

    await websocket.accept()
    _active.add(key)
    conn = _VoiceConnection(websocket, session_id=session_id, user_id=user_id)
    pump_task = asyncio.create_task(conn.pump())
    guard_task = asyncio.create_task(_session_guard(conn))
    try:
        await conn.run()
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.warning("voice session ended with error: %s", exc)
    finally:
        conn._closed = True
        conn._cancel_tts()
        for task in (pump_task, guard_task):
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        _active.discard(key)
        with contextlib.suppress(Exception):
            await websocket.close()


async def _session_guard(conn: _VoiceConnection) -> None:
    """Close a mic left idle too long or open past the max-session ceiling.

    An open mic bills Deepgram per minute, so neither guard is optional. Idle is
    measured on REAL speech (silence keepalive doesn't reset it); the max-session
    cap bounds a well-behaved but forgotten tab.
    """
    started = time.monotonic()
    while not conn._closed:
        await asyncio.sleep(1.0)
        if conn.idle_seconds() > settings.voice_idle_timeout_s:
            logger.info("voice session idle > %ss; closing", settings.voice_idle_timeout_s)
            break
        if time.monotonic() - started > settings.voice_max_session_s:
            logger.info("voice session exceeded max duration; closing")
            break
    conn._closed = True
    with contextlib.suppress(Exception):
        conn._audio_q.put_nowait(None)
    with contextlib.suppress(Exception):
        await conn.ws.close(code=1000)
