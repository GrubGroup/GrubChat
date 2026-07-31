"""Control-frame DTOs for the voice WebSocket relay.

The voice WS multiplexes two kinds of frame on one connection:

  * BINARY frames are audio. Upstream (browser -> gateway -> ai_service) they are
    16 kHz mono ``linear16`` mic chunks; downstream they are Cartesia's 44.1 kHz
    ``pcm_f32le`` TTS. Because audio is always the binary frame, no per-frame
    framing header is needed — the transport's own text/binary bit disambiguates.
  * TEXT frames are JSON control messages, modeled here.

Downstream (ai_service -> browser) control frames:
  ready        — handshake done, mic may start.
  caption      — a live interim/final transcript for the on-screen caption.
  barge_in     — the user started talking; the client must stop TTS playback.
  turn_final   — a finalized user turn transcript (before analyze runs).
  turn_result  — the analyzed turn: reconciled signals + reply + completion.
  speech_end   — the current TTS utterance finished streaming.
  complete     — the member has answered everything; the loop may stop.
  error        — a non-fatal problem (e.g. TTS degraded to text-only).

Upstream (browser -> ai_service, forwarded verbatim by the gateway) control frames:
  mute         — {muted}: while muted the client streams silence (Flux has a 60s
                 idle-with-no-keepalive timeout, so a muted mic must not go quiet).
  stop         — end the session; close the upstream Flux stream and TTS.

``turn_result`` intentionally mirrors the ``AnalyzeResponse`` fields the frontend
chat store already consumes, plus a DERIVED ``is_complete`` (there is no such
column on AnalyzeResponse) so the client has one truth for the "all set" state.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.ai import ConversationTurn, ExtractedSignals

# ---- downstream (server -> client) -----------------------------------------


class ReadyFrame(BaseModel):
    """Sent once the upstream STT stream is open and the mic may start."""

    type: Literal["ready"] = "ready"


class CaptionFrame(BaseModel):
    """A live transcript fragment for the on-screen caption.

    ``is_final`` marks the confirmed end-of-turn text; interim fragments update
    the caption in place. Captions are display-only — never the analyze input.
    """

    type: Literal["caption"] = "caption"
    text: str
    is_final: bool = False


class BargeInFrame(BaseModel):
    """The user began speaking; the client must stop any TTS playback now."""

    type: Literal["barge_in"] = "barge_in"


class TurnFinalFrame(BaseModel):
    """The finalized user-turn transcript, emitted before analyze runs."""

    type: Literal["turn_final"] = "turn_final"
    transcript: str


class TurnResultFrame(BaseModel):
    """The analyzed turn: reconciled signals + agent reply + completion state.

    ``missing_signals`` is the server-recomputed list (the one the hands-free loop
    trusts); ``is_complete`` is derived from it (empty == complete) so the client
    doesn't re-derive completion differently. ``degraded`` is surfaced so the loop
    can decline to auto-advance / mark complete on a degraded (LLM-failed) turn.
    """

    type: Literal["turn_result"] = "turn_result"
    extracted_signals: ExtractedSignals
    missing_signals: list[str] = Field(default_factory=list)
    agent_reply: str
    is_complete: bool = False
    degraded: bool = False
    # DISPLAY-ONLY expansion of the cuisine lists for the "Noted so far" panel,
    # mirroring AnalyzeResponse. extracted_signals stays COMPACT (the stored/echoed
    # form the latency fix relies on) and the spoken line stays short; these carry
    # the expanded members (asian -> chinese, japanese, ...) the panel renders.
    display_preferred_cuisines: list[str] = Field(default_factory=list)
    display_disliked_cuisines: list[str] = Field(default_factory=list)


class SpeechEndFrame(BaseModel):
    """The current TTS utterance finished streaming (all PCM sent)."""

    type: Literal["speech_end"] = "speech_end"


class CompleteFrame(BaseModel):
    """The member answered everything; the loop may stop capturing."""

    type: Literal["complete"] = "complete"


class ErrorFrame(BaseModel):
    """A non-fatal problem worth surfacing (e.g. TTS degraded to text-only)."""

    type: Literal["error"] = "error"
    message: str


# ---- upstream (client -> server) -------------------------------------------


class StartFrame(BaseModel):
    """Seed the connection with the client's current chat context.

    Sent once, before audio, and re-sendable to re-seed. Carries the SAME history
    and signals the text chat already tracks, so a mixed typed+voice session stays
    coherent: typed turns hit HTTP ``/analyze`` and never reach this handler, so
    without seeding a later voice turn would replay a history missing them and
    re-ask (or drop) a typed answer — dietary especially, since Qa has no dietary
    column and ``_merge_prior_qa`` recovers only cuisines/budget/location.
    """

    type: Literal["start"]
    conversation_history: list[ConversationTurn] = Field(default_factory=list)
    current_signals: ExtractedSignals = Field(default_factory=ExtractedSignals)
    # Cartesia voice id the member picked (settings dropdown). Optional — an
    # absent/unknown id resolves to the server default (see voices.resolve_voice_id).
    # The route parses the frame as a raw dict, so this field documents the wire
    # contract rather than gating it.
    voice_id: str | None = None


class MuteFrame(BaseModel):
    """Toggle mute. While muted the client keeps streaming silence frames.

    NOT a pause: Flux closes an idle ``/v2/listen`` socket after ~60s and accepts
    no KeepAlive message, so the mic stream must keep flowing (zeroed) to survive.
    """

    type: Literal["mute"]
    muted: bool


class StopFrame(BaseModel):
    """End the voice session: close the upstream STT stream and any TTS."""

    type: Literal["stop"]
