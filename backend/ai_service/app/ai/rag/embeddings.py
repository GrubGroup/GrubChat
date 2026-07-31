"""Text embeddings via OpenRouter for restaurants/menus (settings.embedding_model)."""

from functools import lru_cache

from openai import AsyncOpenAI

from app.core.config import settings

EMBEDDING_DIMS = 1024


@lru_cache(maxsize=1)
def _client() -> AsyncOpenAI:
    """Lazily build the OpenRouter client (OpenAI-compatible /embeddings API)."""
    return AsyncOpenAI(
        api_key=settings.openrouter_api_key,
        base_url=settings.openrouter_base_url,
    )


async def embed_text(text: str) -> list[float]:
    """Embed `text` into exactly 1024 floats via OpenRouter (settings.embedding_model).

    Requests `dimensions=1024` and hard-asserts the returned length so a mismatch
    fails here rather than at the Postgres vector(1024) insert.
    """
    response = await _client().embeddings.create(
        model=settings.embedding_model,
        input=text,
        dimensions=EMBEDDING_DIMS,
    )
    embedding = response.data[0].embedding
    if len(embedding) != EMBEDDING_DIMS:
        raise ValueError(
            f"Expected {EMBEDDING_DIMS}-dim embedding, got {len(embedding)}"
        )
    return embedding
