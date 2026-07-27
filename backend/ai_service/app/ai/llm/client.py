"""Async LLM client — provider selected by LLM_PROVIDER (env), no code edit needed.

  LLM_PROVIDER=salesforce → Salesforce internal model gateway (Claude) — local dev.
  LLM_PROVIDER=openrouter → OpenRouter/DeepSeek (default) — deploy.
"""

from functools import lru_cache
from typing import Any

import httpx
from openai import AsyncOpenAI

from app.core.config import settings


@lru_cache(maxsize=1)
def get_llm_client() -> AsyncOpenAI:
    """Build the chat LLM client for the provider named by settings.llm_provider.

    Salesforce (LLM_PROVIDER=salesforce): the OpenAI-compatible internal gateway,
    verifying TLS against the corporate CA bundle from NODE_EXTRA_CA_CERTS when set.
    OpenRouter (default): OPENROUTER_API_KEY / OPENROUTER_BASE_URL. The process
    reads one provider per run (lru_cache), and settings.active_llm_model already
    resolves to the matching model name.
    """
    if settings.llm_provider.strip().lower() == "salesforce":
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


async def chat_completion(
    messages: list[dict[str, Any]],
    *,
    model: str | None = None,
    temperature: float = 0.2,
    response_format: dict[str, Any] | None = None,
    max_tokens: int | None = None,
) -> str:
    """Run a chat completion and return the assistant message content.

    `model` defaults to settings.active_llm_model (the model for the selected
    provider). `response_format` (e.g. JSON mode) is passed through when provided;
    providers that ignore it simply return text. `max_tokens`, when set, caps the
    completion length — LLM latency is dominated by output tokens, so callers that
    know their response is bounded (e.g. the group re-rank returns a short JSON
    array) pass it to hard-stop runaway generation.
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

    response = await get_llm_client().chat.completions.create(**kwargs)
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
