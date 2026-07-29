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

    # --- Extraction routing (separate from the ranking/justification model) -----
    # backend/CLAUDE.md's model-routing rule is "cheap model for extraction, strong
    # model for ranking/justification". The conversational analyze turn is
    # EXTRACTION, so it routes here rather than to active_llm_model.
    #
    # This exists because the turn is output-token-bound (~13 ms/token measured):
    # on the strong model it ran ~3.9 s p50 against a ~700 ms real-time voice
    # budget. gemini-2.5-flash via OpenRouter measured ~916 ms p50 / 1388 ms p95
    # at full extraction quality (see scripts/probe_combined_fix.py). Provider is
    # pinned separately because the SAME model was ~3x slower via the Salesforce
    # gateway, so the win comes from the provider+model pair, not the model alone.
    # Set extraction_provider="" to fall back to the main provider/model.
    extraction_provider: str = "openrouter"  # env EXTRACTION_PROVIDER
    extraction_model: str = Field(
        default="google/gemini-2.5-flash",
        validation_alias="EXTRACTION_MODEL",
    )

    # Master switch for the fast analyze path (fast extraction model + delta-shaped
    # response + server-authored reply). On by default: it measured ~4x faster at
    # equal extraction quality, and the reply becomes deterministic, which the
    # voice/TTS path needs. Set ANALYZE_LOW_LATENCY=false to restore the original
    # single-provider, model-written-reply behavior.
    analyze_low_latency: bool = True  # env ANALYZE_LOW_LATENCY

    @computed_field  # type: ignore[prop-decorator]
    @property
    def active_llm_model(self) -> str:
        """The chat model name for the selected provider, so the model always
        matches the client get_llm_client builds."""
        if self.llm_provider.strip().lower() == "salesforce":
            return self.salesforce_llm_model
        return self.openrouter_llm_model

    @computed_field  # type: ignore[prop-decorator]
    @property
    def active_extraction_provider(self) -> str:
        """Provider for extraction turns; falls back to the main provider."""
        return self.extraction_provider.strip().lower() or self.llm_provider.strip().lower()

    @computed_field  # type: ignore[prop-decorator]
    @property
    def active_extraction_model(self) -> str:
        """Model for extraction turns; falls back to the main provider's model."""
        if not self.extraction_provider.strip():
            return self.active_llm_model
        return self.extraction_model

    # Back-compat alias — chat_completion historically read settings.llm_model.
    @computed_field  # type: ignore[prop-decorator]
    @property
    def llm_model(self) -> str:
        return self.active_llm_model

    # --- Voice (STT / TTS relay) -----------------------------------------------
    # Deepgram Flux for streaming STT (wss://api.deepgram.com/v2/listen, auth
    # scheme "Token"); Cartesia Sonic-3.5 for TTS. Both are server-side only —
    # audio never transits with a long-lived key in the browser.
    deepgram_api_key: str = ""  # env DEEPGRAM_API_KEY
    cartesia_api_key: str = ""  # env CARTESIA_API_KEY
    # Cartesia requires a version header; this is the current documented value.
    # Older values are still accepted, so it is configurable rather than pinned.
    cartesia_version: str = "2026-03-01"  # env CARTESIA_VERSION

    # PIN the TTS model to a dated snapshot, not the floating "sonic-3.5" alias:
    # Cartesia rolls the alias to new snapshots with no notice, which drifts timbre
    # and TTFB out from under the measured Stage 3 baseline. Override per deploy.
    cartesia_model: str = "sonic-3.5-2026-05-04"  # env CARTESIA_MODEL
    # The agent voice id. NOTE: this default is the id the scaffold shipped with;
    # it currently resolves but is NOT the documented "Skylar" id (db6b0ed5-…). A
    # stale id fails mid-turn as voice_not_found (silent — the agent just can't
    # speak), so verify with scripts/probe_voice_session.py / GET /voices before a
    # deploy and override here if it has drifted.
    cartesia_voice_id: str = "694f9389-aac1-45b6-b726-9d9369183238"  # env CARTESIA_VOICE_ID
    # Cartesia bills TTS by CONCURRENT contexts, one per /tts/sse POST: 2 Free /
    # 3 Pro / 5 Startup / 15 Scale. A whole group finishing together can exceed the
    # cap; this bounds the per-instance in-flight TTS streams so the overflow queues
    # (and retries a 429) instead of a member hearing silence. Set to the account
    # tier's real limit. Defaults to the Free-tier floor so a misconfig degrades
    # safe rather than 429-ing.
    cartesia_max_concurrency: int = 2  # env CARTESIA_MAX_CONCURRENCY

    # Voice WebSocket session guards (all net-new — an open mic bills Deepgram per
    # minute, so these are load-bearing, not hygiene):
    #  * eot_timeout_ms — Flux's turn-finalization patience. Documented rapid-
    #    response FLOOR is 3000 (not 2000): below it a mid-answer pause
    #    ("vegetarian… uh… no shellfish") finalizes early and splits one spoken
    #    answer into two analyze turns.
    #  * idle timeout — close after this many seconds of no real speech (the mic is
    #    kept alive with silence frames up to here, then we give up).
    #  * max session — hard ceiling on a single voice connection's lifetime.
    voice_eot_timeout_ms: int = 3000  # env VOICE_EOT_TIMEOUT_MS
    voice_idle_timeout_s: int = 45  # env VOICE_IDLE_TIMEOUT_S
    voice_max_session_s: int = 900  # env VOICE_MAX_SESSION_S

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
