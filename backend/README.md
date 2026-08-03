# GrubGroup — Backend

The backend is split into two cooperating services.

```
backend/
├── gateway/      # Node.js + Express + Socket.IO (Bun)  — real-time, auth, proxy
└── ai_service/   # Python + FastAPI (uv)                — AI/Data, agents, RAG, DB
```

## gateway/ — Real-Time Service (Node.js + Express)

The frontend-facing service. Handles:

- WebSocket (Socket.IO) live group event sync — event and session state, fanned out
  across machines by the Postgres adapter
- Better Auth (cookie sessions, email/password + Google OAuth) — the gateway no longer mints JWTs
- React + Vite integration layer (REST API gateway)
- Proxies AI / RAG requests to `ai_service`
- Relays the hands-free voice loop (browser mic ↔ `ai_service` STT/TTS) over Socket.IO
- Proxies the settings-screen voice preview (`POST /api/voice/preview` → WAV bytes)

Run: `cd gateway && bun install && bun run dev`

## ai_service/ — AI / Data Service (FastAPI)

The AI and data backend. Handles:

- SQLModel ORM over PostgreSQL + pgvector
- LangGraph multi-agent pipeline (preference + orchestrator agents)
- RAG (Perplexity `pplx-embed-v1-0.6b` embeddings via OpenRouter + pgvector retrieval)
- LLM calls (Claude Sonnet 5 via OpenRouter, or Claude through the Salesforce internal
  gateway when `LLM_PROVIDER=salesforce`; preference extraction routes separately to
  `google/gemini-2.5-flash` to keep the analyze turn voice-viable)
- Server voice loop — cascaded STT→analyze→TTS over a WebSocket (Deepgram Flux STT, Cartesia TTS)

Run: `cd ai_service && uv sync && uv run uvicorn app.main:app --reload`

## Request flow

```
Frontend (React)  ──REST/WebSocket──▶  gateway (Express/Socket.IO)  ──HTTP──▶  ai_service (FastAPI)  ──▶  PostgreSQL + pgvector
```

## Environment

Each service ships a `.env.example` — copy it to `.env` and fill it in. Two values
must agree across the pair or every AI request fails with a 401:

| Variable       | gateway                | ai_service   | Why                                                      |
| -------------- | ---------------------- | ------------ | -------------------------------------------------------- |
| `JWT_SECRET`   | sent as `X-Internal-Secret` | compared on arrival | The gateway → ai_service hop is a shared-secret check |
| `DATABASE_URL` | Prisma (owns the DDL) + the Socket.IO adapter | SQLModel read-side mirror | Both services point at the same Postgres |

## Deployment

Both services deploy to [Fly.io](https://fly.io) from their own `fly.toml` (region
`sjc`, one shared-CPU 1 GB machine each, built from each service's `Dockerfile`):

| Service      | Fly app              | Port | Health check       |
| ------------ | -------------------- | ---- | ------------------ |
| `gateway`    | `grubgroup-gateway`  | 4000 | `/health`          |
| `ai_service` | `grubgroup-ai`       | 8000 | `/api/v1/health`   |

Secrets are supplied with `fly secrets set` — never committed. When the frontend is
hosted on a different domain than the gateway (it is: frontend on Render, gateway on
Fly), the gateway needs `CROSS_SITE_COOKIES=true` so the Better Auth session cookie
is issued `SameSite=None; Secure` and can ride cross-site.

See each service's own `README.md` for details.
