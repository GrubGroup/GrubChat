# GrubGroup — Backend

The backend is split into two cooperating services.

```
backend/
├── gateway/      # Node.js + Express + Socket.IO (Bun)  — real-time, auth, proxy
└── ai_service/   # Python + FastAPI (uv)                — AI/Data, agents, RAG, DB
```

## gateway/ — Real-Time Service (Node.js + Express)

The frontend-facing service. Handles:

- WebSocket (Socket.IO) live group event sync — event and session state
- Better Auth (cookie sessions, email/password + Google OAuth) — the gateway no longer mints JWTs
- React + Vite integration layer (REST API gateway)
- Proxies AI / RAG requests to `ai_service`
- Relays the hands-free voice loop (browser mic ↔ `ai_service` STT/TTS) over Socket.IO

Run: `cd gateway && bun install && bun run dev`

## ai_service/ — AI / Data Service (FastAPI)

The AI and data backend. Handles:

- SQLModel ORM over PostgreSQL + pgvector
- LangGraph / LangChain multi-agent pipeline (preference + orchestrator agents)
- RAG (Perplexity `pplx-embed-v1-0.6b` embeddings via OpenRouter + pgvector retrieval)
- LLM calls (DeepSeek / Claude via OpenRouter; extraction routed to a fast model)
- Server voice loop — cascaded STT→analyze→TTS over a WebSocket (Deepgram Flux STT, Cartesia TTS)

Run: `cd ai_service && uv sync && uv run uvicorn app.main:app --reload`

## Request flow

```
Frontend (React)  ──REST/WebSocket──▶  gateway (Express/Socket.IO)  ──HTTP──▶  ai_service (FastAPI)  ──▶  PostgreSQL + pgvector
```

See each service's own `README.md` for details.
