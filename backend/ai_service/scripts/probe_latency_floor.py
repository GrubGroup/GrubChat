"""Diagnostic: is the ~2 s per-call LLM floor the PROVIDERS, or this network?

The Stage 0 measurements converged on an uncomfortable constant: no matter how
small the prompt or how capped the output, a single chat completion costs ~1.5-2 s
on BOTH configured providers (Salesforce/Claude gateway and OpenRouter). A
21-character response took ~1.5-1.9 s uncached. That looks like fixed per-call
overhead rather than token cost — and the fix depends entirely on where it lives:

  * If a THIRD provider from this same machine is fast (~300-600 ms), the floor
    belongs to the two configured providers, and switching the chat provider is
    a real lever for the voice path.
  * If EVERY provider is ~2 s from here, the floor is this machine's network
    egress (corporate proxy / VPN). Local numbers then say nothing about
    production, and Stage 0 must be re-run from the deploy environment before
    anyone draws architectural conclusions from them.

This distinction decides whether the voice feature is blocked on infrastructure
or just on configuration, so it is worth one extra probe.

Uses OPENAI_API_KEY, which is present in .env (reserved for the voice relay) and
is a genuinely independent network path. Also times a bare TCP+TLS connect to
each host to separate connection setup from inference.

Run:
    cd backend/ai_service
    uv run python -m scripts.probe_latency_floor
"""

from __future__ import annotations

import asyncio
import os
import ssl
import statistics
import time

import httpx
from openai import AsyncOpenAI

from app.core.config import settings

REPS = 3
# Deliberately trivial: any wall-clock beyond a few hundred ms on this is
# overhead, not generation.
TRIVIAL = [{"role": "user", "content": 'Reply with exactly: {"ok": 1}'}]


def _mean(values: list[float]) -> float:
    return statistics.mean(values) if values else float("nan")


async def _tcp_tls_connect(
    host: str, port: int = 443, *, cafile: str | None = None
) -> float | None:
    """Time a bare TCP+TLS handshake — pure network distance, zero inference.

    `cafile` matters for the Salesforce gateway: its chain is signed by the
    corporate CA (NODE_EXTRA_CA_CERTS), so verifying against the default bundle
    fails and would print a misleading "unreachable" for a host that the
    completion calls reach fine.
    """
    context = ssl.create_default_context(cafile=cafile) if cafile else ssl.create_default_context()
    started = time.perf_counter()
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port, ssl=context),
            timeout=15,
        )
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass
        return (time.perf_counter() - started) * 1000.0
    except Exception:
        return None


async def _time_trivial(client: AsyncOpenAI, model: str, label: str) -> None:
    """Time REPS trivial completions, nonce-varied to defeat any cache."""
    samples: list[float] = []
    for rep in range(REPS):
        messages = [
            {"role": "user", "content": f'Reply with exactly: {{"ok": {rep}}}'}
        ]
        started = time.perf_counter()
        try:
            await client.chat.completions.create(
                model=model, messages=messages, temperature=0.2, max_tokens=32
            )
        except Exception as exc:
            print(f"  {label:<44} FAILED: {type(exc).__name__}: {str(exc)[:90]}")
            return
        samples.append((time.perf_counter() - started) * 1000.0)
    print(
        f"  {label:<44} mean={_mean(samples):8.1f} ms  "
        f"min={min(samples):7.1f}  max={max(samples):7.1f}"
    )


async def _run() -> int:
    print("=" * 78)
    print("  Is the ~2 s per-call floor the providers, or this network?")
    print("=" * 78)
    print(f"  reps: {REPS}   payload: trivial (max_tokens=32, nonce-varied)")
    print()

    print("  --- bare TCP+TLS handshake (network distance only) ---")
    sf_host = settings.salesforce_base_url.split("://")[-1].split("/")[0]
    hosts: list[tuple[str, str, str | None]] = [
        ("api.openai.com", "OpenAI", None),
        ("openrouter.ai", "OpenRouter", None),
        # Corporate CA, else this reports a false "unreachable".
        (sf_host, "Salesforce gateway", settings.node_extra_ca_certs or None),
    ]
    for host, label, cafile in hosts:
        elapsed = await _tcp_tls_connect(host, cafile=cafile)
        shown = f"{elapsed:8.1f} ms" if elapsed is not None else "   unreachable"
        print(f"  {label:<24} {host[:44]:<46} {shown}")
    print()

    print("  --- trivial completion round-trip ---")
    openai_key = os.environ.get("OPENAI_API_KEY", "")
    if openai_key:
        # An independent vendor + network path. gpt-4o-mini is a cheap, widely
        # available tier; if the model name is retired the call reports FAILED
        # and the probe still tells us the other paths' numbers.
        await _time_trivial(
            AsyncOpenAI(api_key=openai_key), "gpt-4o-mini", "OpenAI direct (gpt-4o-mini)"
        )
    else:
        print("  (OPENAI_API_KEY empty — cannot probe an independent provider)")

    if settings.openrouter_api_key:
        await _time_trivial(
            AsyncOpenAI(
                api_key=settings.openrouter_api_key,
                base_url=settings.openrouter_base_url,
            ),
            settings.openrouter_llm_model,
            f"OpenRouter ({settings.openrouter_llm_model})",
        )

    if settings.salesforce_api_key:
        await _time_trivial(
            AsyncOpenAI(
                api_key=settings.salesforce_api_key,
                base_url=settings.salesforce_base_url,
                http_client=httpx.AsyncClient(
                    verify=settings.node_extra_ca_certs or True
                ),
            ),
            settings.salesforce_llm_model,
            f"Salesforce ({settings.salesforce_llm_model})",
        )
    print()

    print("  Read it: if OpenAI direct is fast (<600 ms) while the two configured")
    print("  providers sit at ~2 s, the floor is THEIR overhead — switching the")
    print("  chat provider is a real lever. If everything is ~2 s, the floor is")
    print("  this machine's egress and Stage 0 must be re-run from deploy.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_run()))
