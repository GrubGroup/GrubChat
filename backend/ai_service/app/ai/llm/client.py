"""Async LLM client — provider selected by LLM_PROVIDER (env), no code edit needed.

  LLM_PROVIDER=salesforce → Salesforce internal model gateway (Claude) — local dev.
  LLM_PROVIDER=openrouter → OpenRouter/DeepSeek (default) — deploy.
"""

from functools import lru_cache
from typing import Any

import httpx
from openai import AsyncOpenAI

from app.core.config import settings


@lru_cache(maxsize=4)
def get_client_for(provider: str) -> AsyncOpenAI:
    """Build (and cache) an OpenAI-compatible client for a NAMED provider.

    Keyed by provider name so the extraction path can use a different provider
    from the ranking path within one process — the conversational analyze turn
    routes to a fast provider/model pair while ranking stays on the strong one
    (see settings.active_extraction_provider).

    Salesforce: the internal gateway, verifying TLS against the corporate CA
    bundle from NODE_EXTRA_CA_CERTS when set. OpenRouter: OPENROUTER_API_KEY /
    OPENROUTER_BASE_URL.
    """
    if provider.strip().lower() == "salesforce":
        return AsyncOpenAI(
            api_key=settings.salesforce_api_key,
            base_url=settings.salesforce_base_url,
            http_client=httpx.AsyncClient(
                verify=settings.node_extra_ca_certs or True,
            ),
        )

    return AsyncOpenAI(
        api_key=settings.openrouter_api_key,
        base_url=settings.openrouter_base_url,
    )


def get_llm_client() -> AsyncOpenAI:
    """The chat client for the provider named by settings.llm_provider."""
    return get_client_for(settings.llm_provider)


async def chat_completion(
    messages: list[dict[str, Any]],
    *,
    model: str | None = None,
    temperature: float = 0.2,
    response_format: dict[str, Any] | None = None,
    provider: str | None = None,
    max_tokens: int | None = None,
) -> str:
    """Run a chat completion and return the assistant message content.

    `model` defaults to settings.active_llm_model (the model for the selected
    provider). `provider` overrides which provider's client is used — pass both
    together, since a model name is only valid for its own provider. `max_tokens`
    caps generation, which matters because latency here is output-token-bound
    (~13 ms/token measured). `response_format` (e.g. JSON mode) is passed through
    when provided; providers that ignore it simply return text.
    """
    kwargs: dict[str, Any] = {
        "model": model or settings.active_llm_model,
        "messages": messages,
        "temperature": temperature,
    }
    if response_format is not None:
        kwargs["response_format"] = response_format
    if max_tokens is not None:
        kwargs["max_tokens"] = max_tokens

    client = get_client_for(provider) if provider else get_llm_client()
    response = await client.chat.completions.create(**kwargs)
    return response.choices[0].message.content


def strip_json_fence(raw: str) -> str:
    """Strip markdown code fences so json.loads sees a bare JSON payload.

    The Salesforce/Claude gateway does not honor OpenAI JSON mode, so callers
    prompt for strict JSON and strip fences here rather than relying on
    response_format.
    """
    text = raw.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[-1] if "\n" in text else text
        if text.endswith("```"):
            text = text[: -len("```")]
        # Drop a leading language hint (e.g. ``` remaining after "```json").
        if text.lstrip().lower().startswith("json"):
            text = text.lstrip()[len("json"):]
    return text.strip()
