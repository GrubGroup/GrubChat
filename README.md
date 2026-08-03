# SITE Capstone Project

SITE Course Year: **2026**

Cohort: **Salesforce**

Team Member Names: **Della Lee, Daniel Lam, Audrey Dequito, Miguel Cuevas**

Mentors Names: **Jennifer Jin, Allan George Thomas, Areeta Wong, Ashish Khanchandani, Raghav Abboy, Rajiv Kochumman**

Project Code Repository Links

- [Frontend Repo Link](https://github.com/GrubGroup/GrubGroup/tree/main/frontend)
- [Backend Repo Link](https://github.com/GrubGroup/GrubGroup/tree/main/backend)

## Project Overview

A consumer-facing, "voice-first" web app where a group of friends each talk to their own AI agent about what they want to eat. A master AI orchestrator agent collects everyone's dietary preferences, budget, and location in real-time, finds restaurants that satisfy the whole group, lets each person browse and order from a shared menu, and connects everything into one group cart. This is all driven by a conversational, voice-enabled interface. Think Uber Eats but a group chat based on preference based on profile information.

- **`frontend/`** — React 19 + TypeScript + Vite 8 SPA. Routed with react-router v8 (`/groups/:groupId`, `/groups/:groupId/sessions/:sessionId`, `/events/:eventId`, …); zustand for client state. Auth via Better Auth client (cookie session). Managed with **Bun**.
- **`backend/gateway/`** — Node.js + Express 4 + Socket.IO 4. Frontend-facing service: runs Better Auth (cookie sessions, email/password + Google OAuth), Socket.IO live group chat and session sync, Prisma (owns DB schema + migrations + pgvector extension), proxies AI requests to `ai_service`. Managed with **Bun**.
- **`backend/ai_service/`** — Python 3.14 + FastAPI + SQLModel + asyncpg. The AI/data brain: LangGraph multi-agent pipeline (per-member preference agent → group orchestrator), RAG (Perplexity `pplx-embed-v1-0.6b` embeddings via OpenRouter + pgvector similarity search), LLM chat, and a cascaded STT→analyze→TTS voice loop. Read-side SQLModel mirror of the Prisma schema; also writes `Recommendation`/`RecommendationItem` + `Qa` rows and update-only `Profile` signals. Managed with **uv**.

Deployment Website: **Add Link to Deployed Project**

### Open-source libraries used

**Frontend** (`frontend/`)

- [React](https://react.dev/) + [React DOM](https://react.dev/) — UI library
- [TypeScript](https://www.typescriptlang.org/) — typed JavaScript
- [Vite](https://vite.dev/) + [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react) — build tool / dev server
- [Tailwind CSS](https://tailwindcss.com/) + [@tailwindcss/vite](https://tailwindcss.com/docs/installation/using-vite) — styling
- [React Router](https://reactrouter.com/) — routing (v8; import from `react-router`)
- [Zustand](https://github.com/pmndrs/zustand) — client-side state (navigation is owned by the URL)
- [Framer Motion](https://motion.dev/) — animations
- [Axios](https://axios-http.com/) — HTTP client to the gateway
- [Socket.IO Client](https://socket.io/) — real-time client
- [Better Auth](https://www.better-auth.com/) — auth client (cookie sessions)
- [react-speech-recognition](https://github.com/JamesBrill/react-speech-recognition) — browser voice input
- [ESLint](https://eslint.org/) · [typescript-eslint](https://typescript-eslint.io/) · [Prettier](https://prettier.io/) — linting / formatting

**Gateway** (`backend/gateway/`)

- [Express](https://expressjs.com/) — HTTP framework
- [Socket.IO](https://socket.io/) — real-time WebSocket server
- [@socket.io/postgres-adapter](https://socket.io/docs/v4/postgres-adapter/) + [node-postgres](https://node-postgres.com/) — cross-machine broadcast fan-out
- [Better Auth](https://www.better-auth.com/) — cookie-session auth (email/password + Google OAuth)
- [Prisma](https://www.prisma.io/) + [@prisma/client](https://www.prisma.io/docs/orm/prisma-client) — ORM, schema, and migrations
- [Axios](https://axios-http.com/) — HTTP client to the AI service
- [cors](https://github.com/expressjs/cors) — CORS middleware
- [dotenv](https://github.com/motdotla/dotenv) — environment config
- Runtime + package manager: [Bun](https://bun.sh/)

**AI service** (`backend/ai_service/`)

- [FastAPI](https://fastapi.tiangolo.com/) — async web framework
- [SQLModel](https://sqlmodel.tiangolo.com/) — ORM / data layer (built on SQLAlchemy)
- [asyncpg](https://github.com/MagicStack/asyncpg) — async PostgreSQL driver
- [pgvector (Python)](https://github.com/pgvector/pgvector-python) — vector similarity for RAG
- [LangGraph](https://www.langchain.com/langgraph) — multi-agent pipeline (`StateGraph` fan-out → orchestrator)
- [OpenAI Python SDK](https://github.com/openai/openai-python) — LLM + embeddings client (OpenRouter / Salesforce gateway)
- [httpx](https://www.python-httpx.org/) — async HTTP client
- [websockets](https://websockets.readthedocs.io/) — streaming STT transport for the voice loop
- [Pydantic Settings](https://docs.pydantic.dev/latest/concepts/pydantic_settings/) + [python-dotenv](https://github.com/theskumar/python-dotenv) — config
- [greenlet](https://github.com/python-greenlet/greenlet) — async SQLAlchemy runtime dependency
- Runtime + package manager: [uv](https://docs.astral.sh/uv/)

**Database**

- [PostgreSQL](https://www.postgresql.org/) + [pgvector](https://github.com/pgvector/pgvector) — relational store + vector search
