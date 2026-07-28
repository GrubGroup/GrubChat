"""Application settings loaded from environment via pydantic-settings."""

from pydantic import AliasChoices, Field, computed_field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Environment-backed settings. Reads from the ai_service .env file."""

    # Database (asyncpg driver). Schema is owned/migrated by Prisma in the
    # gateway; ai_service holds a read-side SQLModel mirror (no create_all).
    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/grubgroup"

    # Which chat LLM provider get_llm_client builds. "salesforce" routes through the
    # internal model gateway (Claude), "openrouter" through OpenRouter/DeepSeek.
    # Defaults to openrouter so a checkout with no Salesforce creds/CA still runs;
    # set LLM_PROVIDER=salesforce locally, leave unset (or =openrouter) on deploy.
    llm_provider: str = "openrouter"  # env LLM_PROVIDER

    # Embeddings (active): served via OpenRouter's /embeddings API, 1024-dim.
    # OpenRouter also serves chat when llm_provider == "openrouter".
    openrouter_api_key: str = ""
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    # LATENCY FIX (2026-07-27): was "qwen/qwen3-embedding-8b" (measured 24-60s per
    # call — no dedicated OpenRouter provider, so each request cold-started a
    # serverless GPU; this was ~90% of "view results" latency). Switched to
    # text-embedding-3-small (0.42s), then (2026-07-28) to pplx-embed-v1-0.6b,
    # which returns 1024 dims natively (vector(1024) unchanged) at lower cost and
    # ~0.2s. TO REVERT: restore the desired model here AND in .env, then re-embed
    # all Restaurant rows (cross-model vectors are not comparable).
    embedding_model: str = "perplexity/pplx-embed-v1-0.6b"
    # OpenRouter chat model (env LLM_MODEL). Used when llm_provider == "openrouter".
    openrouter_llm_model: str = Field(
        default="deepseek/deepseek-chat",
        validation_alias="LLM_MODEL",
    )

    # Salesforce internal model gateway (OpenAI-compatible). Used when
    # llm_provider == "salesforce".
    salesforce_api_key: str = ""  # env SALESFORCE_API_KEY
    salesforce_base_url: str = (
        "https://eng-ai-model-gateway.sfproxy.devx-preprod.aws-esvc1-useast2.aws.sfdc.cl"
    )
    node_extra_ca_certs: str = ""  # env NODE_EXTRA_CA_CERTS (corporate CA bundle path)
    # Salesforce chat model (env SALESFORCE_LLM_MODEL).
    salesforce_llm_model: str = Field(
        default="claude-sonnet-4-5-20250929",
        validation_alias="SALESFORCE_LLM_MODEL",
    )

    @computed_field  # type: ignore[prop-decorator]
    @property
    def active_llm_model(self) -> str:
        """The chat model name for the selected provider, so the model always
        matches the client get_llm_client builds."""
        if self.llm_provider.strip().lower() == "salesforce":
            return self.salesforce_llm_model
        return self.openrouter_llm_model

    # Back-compat alias — chat_completion historically read settings.llm_model.
    @computed_field  # type: ignore[prop-decorator]
    @property
    def llm_model(self) -> str:
        return self.active_llm_model

    # Shared internal secret guarding service-to-service endpoints (must match
    # the gateway JWT_SECRET).
    jwt_secret: str = "change-me"

    # Geocodio API key — turns a member's named location into lat/lon on the
    # conversational analyze path. Accepts either GEOCODIO_API_KEY or the
    # gateway's GEOCODIO_API name. Optional: absent key degrades to null coords.
    geocodio_api_key: str = Field(
        default="",
        validation_alias=AliasChoices("GEOCODIO_API_KEY", "GEOCODIO_API"),
    )

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )


settings = Settings()
