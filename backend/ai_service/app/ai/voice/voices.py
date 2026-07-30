"""Allowlist of selectable Cartesia TTS voices for the session voice loop.

The client (settings dropdown) sends a ``voice_id`` in the voice-loop ``start``
frame. That value is untrusted, so it is validated HERE before being handed to
``tts.stream_audio(voice_id=...)`` — an id not on this list falls back to the
configured default voice (``settings.cartesia_voice_id``) rather than reaching
Cartesia unchecked.

Mirror of the frontend option list (``frontend/src/constants/voices.ts``); keep
the two in sync. The names/genders are UI-only — only the ids matter here.
"""

from __future__ import annotations

from app.core.config import settings

# id -> human label (label unused server-side, kept for logging/debuggability).
SELECTABLE_VOICES: dict[str, str] = {
    "a5136bf9-224c-4d76-b823-52bd5efcffcc": "Jameson (Male)",
    "4f7f1324-1853-48a6-b294-4e78e8036a83": "Casper (Male)",
    "f039066f-cdb7-45ed-b51d-1034ae2f04a0": "Cindy Baker (Female)",
    "f9836c6e-a0bd-460e-9d3c-f7299fa60f94": "Caroline (Female)",
}


def resolve_voice_id(requested: str | None) -> str:
    """Return a safe Cartesia voice id for a client-requested value.

    A value on the allowlist is used as-is; anything else (None, empty, unknown,
    or tampered) resolves to the server default so a bad id can never fail a turn
    mid-stream as ``voice_not_found``.
    """
    if requested and requested in SELECTABLE_VOICES:
        return requested
    return settings.cartesia_voice_id
