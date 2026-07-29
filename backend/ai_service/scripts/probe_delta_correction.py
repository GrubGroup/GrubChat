"""Diagnose the Stage 0b correction regression: raw delta output on a flip turn.

``scripts/verify_stage0b.py`` caught one real failure. On "actually I do like
chinese, and drop the mexican" with prior
``preferred=[mexican], disliked=[chinese]``, the reconciled
``preferred_cuisines`` came back **empty** — chinese never landed. Everything else
(removal of mexican, dropping chinese from disliked, budget untouched) was right.

Hypothesis: the delta override is ambiguous about GRANULARITY. "Return only the
fields that changed" can be read two ways — emit the field's complete new list,
or emit only the incremental change within the field. If the model reads it the
second way, it reports the removal via ``removed_preferred`` and never emits
``preferred_cuisines`` at all. ``_merge_cuisine_field`` then takes the
``parsed_list is None`` branch, starts from the prior list, applies removals, and
so produces [] — the addition is silently lost.

This prints the raw JSON for that turn so the actual failure is visible rather
than inferred, and re-runs it against a tightened override to confirm the fix.

Run:
    cd backend/ai_service
    uv run python -m scripts.probe_delta_correction
"""

from __future__ import annotations

import asyncio
import json

from app.ai.agents.conversation_agent import _reconcile
from app.ai.llm.client import chat_completion, strip_json_fence
from app.ai.llm.prompts import (
    PREFERENCE_TURN_DELTA_OVERRIDE,
    build_preference_turn_messages,
)
from app.core.config import settings
from app.schemas.ai import ExtractedSignals

MESSAGE = "actually I do like chinese, and drop the mexican"
PRIOR = ExtractedSignals(
    preferred_cuisines=["mexican"],
    disliked_cuisines=["chinese"],
    budget_max=30,
)


async def _one(label: str, override: str) -> None:
    """Run the correction turn with a given override and show raw + reconciled."""
    messages = build_preference_turn_messages(
        MESSAGE,
        current_signals=PRIOR.model_dump(),
        message_source="voice",
        is_host=False,
    )
    # Swap in the override under test (build_* applied the shipped one).
    messages[0]["content"] = messages[0]["content"].replace(
        PREFERENCE_TURN_DELTA_OVERRIDE, ""
    ) + override

    raw = await chat_completion(
        messages,
        temperature=0.2,
        provider=settings.active_extraction_provider,
        model=settings.active_extraction_model,
    ) or ""

    print(f"  --- {label} ---")
    print(f"    RAW: {strip_json_fence(raw)[:340]}")
    try:
        parsed = json.loads(strip_json_fence(raw))
    except (ValueError, TypeError):
        print("    UNPARSEABLE")
        return
    raw_signals = parsed.get("extracted_signals")
    if not isinstance(raw_signals, dict):
        raw_signals = parsed
    print(f"    keys present: {sorted(raw_signals)}")
    reconciled = _reconcile(PRIOR, raw_signals)
    print(f"    reconciled preferred: {reconciled.preferred_cuisines}")
    print(f"    reconciled disliked : {reconciled.disliked_cuisines}")
    ok = (
        "chinese" in reconciled.preferred_cuisines
        and "mexican" not in reconciled.preferred_cuisines
        and "chinese" not in reconciled.disliked_cuisines
    )
    print(f"    VERDICT: {'PASS' if ok else 'FAIL'}")
    print()


async def _run() -> int:
    print("=" * 78)
    print("  Delta-shape correction regression")
    print("=" * 78)
    print(f"  prior: preferred={PRIOR.preferred_cuisines} disliked={PRIOR.disliked_cuisines}")
    print(f"  message: {MESSAGE!r}")
    print(f"  model: {settings.active_extraction_provider}/{settings.active_extraction_model}")
    print()

    await _one("A. SHIPPED override (currently failing)", PREFERENCE_TURN_DELTA_OVERRIDE)
    await _one("B. NO override (full-output baseline)", "")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_run()))
