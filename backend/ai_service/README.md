# GrubGroup — AI / Data Service (FastAPI)

Python backend dedicated to API logic, agent orchestration, and the AI pipeline.

## Responsibilities

- **SQLModel ORM** — read-side mirror of the Prisma-owned schema over PostgreSQL + pgvector (data layer)
- **LangGraph / LangChain** multi-agent pipeline (per-user preference agent + group orchestrator agent)
- **RAG** — Perplexity `pplx-embed-v1-0.6b` embeddings (1024-dim) via OpenRouter + pgvector retrieval over restaurants
- **LLM chat calls** — provider chosen at runtime by `LLM_PROVIDER` (default `openrouter` → Claude/DeepSeek; `salesforce` → Claude via the internal gateway) for ranking, reasoning, and reply generation. Preference **extraction** routes separately to a fast model (`EXTRACTION_MODEL`, default `google/gemini-2.5-flash`) to keep the analyze turn voice-viable.
- **Server voice loop** — a WebSocket (`/api/v1/voice/session`) running a cascaded **STT → analyze → TTS** shell: Deepgram Flux streaming STT + Cartesia TTS. Transcribed text feeds the same `analyze_turn` extraction as typed text.
- **Voice preview** — `POST /api/v1/voice/preview` renders one fixed sentence in a chosen (allowlisted) Cartesia voice and returns a complete WAV, so the frontend's settings picker can be auditioned without opening a session. The transcript never varies, so each voice is synthesized at most once per process and cached in memory.

The Node.js **gateway** service proxies AI/RAG requests to this service.

## Stack

FastAPI · SQLModel · asyncpg · pgvector · LangChain · LangGraph · OpenAI/OpenRouter · websockets · pydantic-settings. Managed with [`uv`](https://docs.astral.sh/uv/), Python 3.14.

## Project layout

```
app/
  main.py        # FastAPI app factory
  core/          # config.py (pydantic-settings) — the only module here
  db/            # session.py (async engine/factory); init_db.py (intentional stub — Prisma owns DDL)
  models/        # SQLModel tables (read-side mirror of Prisma)
  schemas/       # Pydantic DTOs — ai.py (Embed/Recommendation/Analyze) + voice.py (voice-loop frames)
  api/           # deps.py (X-Internal-Secret guard); v1/ routers — health, ai, voice
  services/      # business logic (recommendation, session/analyze, profile, geocode)
  crud/          # async data access (session, restaurant, recommendation, user)
  ai/            # llm / rag / agents / graph / voice (Deepgram Flux STT + Cartesia TTS + keyterms) + taxonomy/geo/hours
scripts/         # seed_restaurants, backfill_embeddings, demo/latency/voice probes (no reset_db — Prisma owns DDL)
```

## Getting started

```bash
uv sync                       # create .venv and install dependencies
cp .env.example .env          # fill in DATABASE_URL and API keys
uv run uvicorn app.main:app --reload
```

Seed mock data:

```bash
uv run python -m scripts.seed_restaurants
```
