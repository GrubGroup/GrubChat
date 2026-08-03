# GrubGroup — AI / Data Service (FastAPI)

Python backend dedicated to API logic, agent orchestration, and the AI pipeline.

## Responsibilities

- **SQLModel ORM** — read-side mirror of the Prisma-owned schema over PostgreSQL + pgvector (data layer)
- **LangGraph** multi-agent pipeline (per-user preference agent + group orchestrator agent)
- **RAG** — Perplexity `pplx-embed-v1-0.6b` embeddings (1024-dim) via OpenRouter + pgvector retrieval over restaurants
- **LLM chat calls** — provider chosen at runtime by `LLM_PROVIDER` (default `openrouter` → `anthropic/claude-sonnet-5`; `salesforce` → Claude via the internal gateway, which requires `SALESFORCE_BASE_URL`) for ranking, reasoning, and reply generation. Preference **extraction** routes separately to a fast model (`EXTRACTION_MODEL`, default `google/gemini-2.5-flash`) to keep the analyze turn voice-viable.
- **Server voice loop** — a WebSocket (`/api/v1/voice/session`) running a cascaded **STT → analyze → TTS** shell: Deepgram Flux streaming STT + Cartesia TTS. Transcribed text feeds the same `analyze_turn` extraction as typed text.
- **Voice preview** — `POST /api/v1/voice/preview` renders one fixed sentence in a chosen (allowlisted) Cartesia voice and returns a complete WAV, so the frontend's settings picker can be auditioned without opening a session. The transcript never varies, so each voice is synthesized at most once per process and cached in memory.

The Node.js **gateway** service proxies AI/RAG requests to this service.

## Stack

FastAPI · SQLModel · asyncpg · pgvector · LangGraph · OpenAI/OpenRouter · httpx · websockets · pydantic-settings. Managed with [`uv`](https://docs.astral.sh/uv/), Python 3.14.

## Project layout

```
app/
  main.py        # FastAPI app factory
  core/          # config.py (pydantic-settings) — the only module here
  db/            # session.py — async engine + session factory (Prisma owns the DDL)
  models/        # SQLModel tables (read-side mirror of Prisma)
  schemas/       # Pydantic DTOs — ai.py (Embed/Recommendation/Analyze) + voice.py (voice-loop frames)
  api/           # deps.py (X-Internal-Secret guard); v1/ routers — health, ai, voice
  services/      # business logic (recommendation, session/analyze, profile, geocode)
  crud/          # async data access (session, restaurant, recommendation, user)
  ai/            # llm / rag / agents / graph / voice (Deepgram Flux STT + Cartesia TTS,
                 #   keyterms, voices allowlist) + taxonomy / geo / hours / budget
scripts/         # dev + ops tooling (see below) — no reset_db, Prisma owns the DDL
```

## API surface

Everything is mounted under `/api/v1` and guarded by the `X-Internal-Secret` header
(the gateway is the only caller):

| Method | Path                                     | Purpose                                        |
| ------ | ---------------------------------------- | ---------------------------------------------- |
| GET    | `/health`                                | Liveness probe                                 |
| POST   | `/embed`                                 | Embed text → 1024-dim vector                   |
| POST   | `/sessions/{id}/recommendations`         | Run the group orchestrator, persist + return   |
| POST   | `/sessions/{id}/analyze`                 | Analyze one member's in-session turn           |
| POST   | `/analyze`                               | Analyze a turn with no session (profile edit)  |
| WS     | `/voice/session`                         | Cascaded STT → analyze → TTS voice loop        |
| POST   | `/voice/preview`                         | One fixed line in a chosen voice → WAV         |

## Scripts

```
seed_restaurants.py       # seed ~54 mock restaurants (with embeddings)
backfill_embeddings.py    # (re)embed existing rows — run after an EMBEDDING_MODEL change
smoke_orchestrator.py     # end-to-end orchestrator graph smoke test
demo_orchestrator.py      # narrated walkthrough of the recommendation pipeline
analyze_turn_demo.py      # conversational analyze-turn demo
interactive_session.py    # type-your-own-answers session harness
live_http_gateway_e2e.py  # live HTTP harness across ai_service + gateway
verify_budget_ceiling.py  # offline assertion suite for budget/no-cap semantics
measure_analyze_latency.py, probe_extractor_bench.py   # latency + extraction-model benchmarks
probe_voice_session.py, probe_flux_stt.py, probe_cartesia_tts.py  # voice-path smoke tests
```

## Getting started

```bash
uv sync                       # create .venv and install dependencies
cp .env.example .env          # fill in DATABASE_URL, JWT_SECRET, and API keys
uv run uvicorn app.main:app --reload
```

`JWT_SECRET` is the shared secret for the gateway → ai_service hop (sent as
`X-Internal-Secret`). It **must** match `JWT_SECRET` in `backend/gateway/.env`, or
every proxied AI request returns 401.

Seed mock data:

```bash
uv run python -m scripts.seed_restaurants
```
