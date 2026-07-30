"""Diagnostic: is the DEPLOY provider path (openrouter) usable for the analyze turn?

``scripts/probe_latency_levers.py`` turned up an alarming outlier worth its own
probe: on the REAL production preference prompt, ``openrouter /
deepseek/deepseek-v4-flash`` averaged **46 s** (20 s-96 s) while emitting ~3585
completion tokens — versus ~183 tokens from the Salesforce/Claude path on the
identical prompt. On a slim 74-token prompt the same model returned in ~2.6 s
with ~150 tokens, so the blow-up is triggered by the large prompt, not the model
being uniformly slow.

This matters well beyond voice. ``LLM_PROVIDER`` defaults to ``openrouter``
(local dev here is set to ``salesforce``), so this is plausibly the path a
deployed instance takes for every conversational turn. Before recommending any
voice architecture, establish whether that path even returns usable JSON.

What this checks, per call: wall-clock, completion-token count, whether the
output parses as JSON the way ``analyze_turn`` requires, and whether
``analyze_turn`` would fall back to its degraded path. Nonce-varied to defeat
response caching.

Run:
    cd backend/ai_service
    uv run python -m scripts.probe_deploy_provider
"""

from __future__ import annotations

import asyncio
import json
import time

from openai import AsyncOpenAI

from app.ai.llm.client import strip_json_fence
from app.ai.llm.prompts import build_preference_turn_messages
from app.core.config import settings
from app.schemas.ai import ExtractedSignals

REPS = 3
MESSAGE = "i'm not feeling greasy food, want something lighter to eat"


async def _probe(client: AsyncOpenAI, model: str, label: str) -> None:
    """Time REPS real production-prompt calls and validate the JSON contract."""
    print(f"  --- {label} ({model}) ---")
    for rep in range(REPS):
        messages = build_preference_turn_messages(
            f"{MESSAGE} (ref {rep})",
            current_signals=ExtractedSignals().model_dump(),
            message_source="voice",
            is_host=False,
        )
        started = time.perf_counter()
        try:
            response = await client.chat.completions.create(
                model=model, messages=messages, temperature=0.2
            )
        except Exception as exc:
            print(f"    rep {rep + 1}: FAILED {type(exc).__name__}: {exc}")
            continue
        elapsed = (time.perf_counter() - started) * 1000.0

        content = response.choices[0].message.content or ""
        usage = getattr(response, "usage", None)
        out_tok = getattr(usage, "completion_tokens", "?") if usage else "?"

        # Reproduce exactly what analyze_turn does with the raw text.
        try:
            parsed = json.loads(strip_json_fence(content))
            ok = isinstance(parsed, dict)
            has_reply = bool(isinstance(parsed, dict) and parsed.get("agent_reply"))
            verdict = "JSON ok" if ok else "JSON not an object"
            if ok and not has_reply:
                verdict += ", but NO agent_reply (degraded reply)"
        except (ValueError, TypeError):
            verdict = "UNPARSEABLE -> analyze_turn DEGRADES"

        print(
            f"    rep {rep + 1}: {elapsed:9.1f} ms  out_tok={out_tok:<6} "
            f"chars={len(content):<6} {verdict}"
        )
        # A runaway completion is the whole reason for this probe — show its head
        # so the failure mode is visible rather than inferred from a token count.
        if isinstance(out_tok, int) and out_tok > 600:
            print(f"      RUNAWAY head: {content[:220]!r}")
    print()


async def _run() -> int:
    print("=" * 78)
    print("  Deploy-provider viability for the analyze turn")
    print("=" * 78)
    print(f"  LLM_PROVIDER (this env) = {settings.llm_provider}")
    print("  NOTE: the code default is 'openrouter' — likely the DEPLOY path.")
    print(f"  reps per provider: {REPS} (nonce-varied)")
    print()

    if settings.openrouter_api_key:
        await _probe(
            AsyncOpenAI(
                api_key=settings.openrouter_api_key,
                base_url=settings.openrouter_base_url,
            ),
            settings.openrouter_llm_model,
            "openrouter (DEPLOY DEFAULT)",
        )
    else:
        print("  (OPENROUTER_API_KEY empty — cannot probe the deploy path)\n")

    if settings.salesforce_api_key:
        import httpx

        await _probe(
            AsyncOpenAI(
                api_key=settings.salesforce_api_key,
                base_url=settings.salesforce_base_url,
                http_client=httpx.AsyncClient(
                    verify=settings.node_extra_ca_certs or True
                ),
            ),
            settings.salesforce_llm_model,
            "salesforce (LOCAL DEV)",
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_run()))
