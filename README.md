# GrubGroup

A voice-first, group restaurant-recommendation web app. A group of friends each talks (voice or text) to their own AI preference agent; a master orchestrator agent reconciles everyone's dietary needs, budget, and location in real time, finds restaurants that satisfy the whole group via pgvector RAG, and produces a shared top-5 that the host confirms into a group Event.

**SITE Capstone Project 2026** — Salesforce Cohort

**Team:** Della Lee, Daniel Lam, Audrey Dequito, Miguel Cuevas

**Mentors:** Jennifer Jin, Allan George Thomas, Areeta Wong, Ashish Khanchandani, Raghav Abboy, Rajiv Kochumman

---

## Repo shape

This is a monorepo with three areas:

- **`frontend/`** — React 19 + TypeScript + Vite 8 SPA. Routed with react-router v8 (`/groups/:groupId`, `/groups/:groupId/session/:sessionId`, `/events/:eventId`, …); zustand for client state. Auth via Better Auth client (cookie session). Managed with **Bun**.
- **`backend/gateway/`** — Node.js + Express 4 + Socket.IO 4. Frontend-facing service: runs Better Auth (cookie sessions, email/password + Google OAuth), Socket.IO live group chat and session sync, Prisma (owns DB schema + migrations + pgvector extension), proxies AI requests to `ai_service`. Managed with **Bun**.
- **`backend/ai_service/`** — Python 3.14 + FastAPI + SQLModel + asyncpg. The AI/data brain: LangGraph multi-agent pipeline (per-member preference agent → group orchestrator), RAG (Qwen embeddings via OpenRouter + pgvector similarity search), LLM chat. Read-side SQLModel mirror of the Prisma schema; also writes `Recommendation`/`RecommendationItem` + `Qa` rows. Managed with **uv**.

## Tech stack

| Layer     | Tech                                                                                                         | Package manager |
| --------- | ------------------------------------------------------------------------------------------------------------ | --------------- |
| Frontend  | React 19 · TypeScript · Vite 8 · TailwindCSS 4 (v4 via `@tailwindcss/vite`) · zustand                        | **Bun**         |
| Gateway   | Node.js · Express 4 · Socket.IO 4 · Better Auth · Prisma (plain JS ESM)                                      | **Bun**         |
| AI/Data   | FastAPI · SQLModel · asyncpg · LangChain/LangGraph (Python 3.14)                                             | **uv**          |
| Database  | PostgreSQL + pgvector (schema owned by Prisma in `gateway/`)                                                 | —               |
| Auth      | Better Auth (cookie sessions, email/password + Google OAuth)                                                 | —               |
| LLM / RAG | OpenRouter → Claude/DeepSeek (default) or Salesforce gateway → Claude (chat); Qwen embeddings via OpenRouter | —               |
| Voice     | Browser speech-to-text input (`react-speech-recognition` in frontend); server STT/TTS relay scaffolded but unwired — the next planned feature | —               |
| Deploy    | Render.com · GitHub Actions · Docker (ai_service)                                                            | —               |

## Getting started

### Prerequisites

- [Bun](https://bun.sh) (JavaScript/TypeScript package manager)
- [uv](https://docs.astral.sh/uv/) (Python package manager)
- PostgreSQL with [pgvector](https://github.com/pgvector/pgvector) extension

### Installation and running

All three services plus PostgreSQL must run together. The frontend talks exclusively to the gateway (REST + Socket.IO); the gateway proxies AI requests to `ai_service` via HTTP. One shared PostgreSQL database; Prisma (in gateway) owns all DDL/migrations.

**1. Database setup**

Ensure PostgreSQL is running with the pgvector extension enabled. Set `DATABASE_URL` in both backend services' `.env` files to point to the same database (driver-prefix split: gateway uses `postgresql://`, ai_service uses `postgresql+asyncpg://`).

**2. Gateway** (port 4000)

```bash
cd backend/gateway
bun install
cp .env.example .env      # fill in DATABASE_URL, BETTER_AUTH_SECRET, JWT_SECRET
bun run dev               # bun --watch server.js
```

Runs Prisma migrations on startup via the postinstall hook.

**3. AI Service** (port 8000)

```bash
cd backend/ai_service
uv sync
cp .env.example .env      # fill in DATABASE_URL (asyncpg driver), JWT_SECRET (must match gateway), API keys
uv run uvicorn app.main:app --reload
```

Seed mock restaurants:

```bash
uv run python -m scripts.seed_restaurants
```

**4. Frontend** (port 5173)

```bash
cd frontend
bun install
cp .env.example .env      # optional: VITE_GATEWAY_URL (default http://localhost:4000)
bun run dev               # Vite dev server
```

Visit [http://localhost:5173](http://localhost:5173).

**Note:** `CORS_ORIGIN` in the gateway's `.env` must match the Vite dev server origin (default `http://localhost:5173`).

## Architecture

```
   Browser                Node service               Python service            Database
┌────────────┐   REST /   ┌──────────────┐   HTTP    ┌───────────────┐        ┌──────────┐
│  frontend  │◀─socket.io▶│   gateway    │◀─────────▶│   ai_service  │◀──────▶│ Postgres │
│  (React)   │            │ (Express +   │ X-Internal│  (FastAPI +   │        │ +pgvector│
│            │            │  Socket.IO)  │ -Secret   │  LangGraph)   │        │          │
└────────────┘            └──────────────┘           └───────────────┘        └──────────┘
```

- Frontend → gateway only. The browser never calls `ai_service` directly.
- Better Auth owns browser-edge authentication (cookie sessions); the gateway→ai_service hop uses a shared secret (`X-Internal-Secret`, value from `JWT_SECRET` env var, must be identical in both services).
- One shared PostgreSQL database, accessed directly by both backend services (Prisma in gateway for DDL/writes; SQLModel + asyncpg in ai_service for reads + recommendation writes).
- Real-time group chat and session state sync happen over Socket.IO in the gateway.

## Documentation

- [CLAUDE.md](CLAUDE.md) — project memory bank: what GrubGroup is, repo shape, tech stack, architecture rules, domain entities, team ownership, project status
- [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md) — full folder tree and "where do I put…?" guide
- [backend/CLAUDE.md](backend/CLAUDE.md) — backend working rules and commands (gateway + ai_service)
- [frontend/CLAUDE.md](frontend/CLAUDE.md) — frontend working rules and commands
- [planning/](planning/) — product plan, proposal, user stories, UI design

## Team ownership

- **Daniel** — FastAPI AI service, LangGraph pipeline, LLM integration
- **Miguel** — SQLModel data layer, DB schema, seeding
- **Audrey** — Frontend design, auth system (Better Auth in the gateway)
- **Della** — Real-time WebSocket layer, deployment pipeline

## Package managers (hard rule)

- **Bun** for all JavaScript/TypeScript (both `frontend/` and `backend/gateway/`)
- **uv** for all Python (`backend/ai_service/`)
- Do not use npm, yarn, pnpm, pip, or venv directly

---

## License

This project is part of the SITE 2026 capstone program.
