# GrubGroup — Project File Structure

This document explains how the GrubGroup repository is organized.

---

## 1. Overview (for everyone)

GrubGroup is a voice-first, group restaurant-recommendation web app. The repository is a
**monorepo** with three top-level areas:

| Area                         | What it is                                           | Who owns it  |
| ---------------------------- | ---------------------------------------------------- | ------------ |
| `frontend/`                  | The React web app users interact with in the browser | Frontend     |
| `backend/`                   | The server side, split into two cooperating services | Backend / AI |
| `planning/` & `reflections/` | Project docs, proposals, and weekly team reflections | Whole team   |

The backend is itself split into **two services**:

- **`backend/gateway/`** — Node.js + Express + Socket.IO. The frontend talks to this. It
  handles real-time updates, auth (Better Auth cookie sessions), and forwards AI requests to the
  AI service.
- **`backend/ai_service/`** — Python + FastAPI. The "brains": AI agents, restaurant
  search (RAG), and the database.

### How the pieces talk to each other

```
   Browser                Node service               Python service            Database
┌────────────┐   REST /   ┌──────────────┐   HTTP    ┌───────────────┐        ┌──────────┐
│  frontend  │◀─socket.io▶│   gateway    │◀─────────▶│   ai_service  │◀──────▶│ Postgres │
│  (React)   │            │ (Express +   │           │  (FastAPI +   │        │ +pgvector│
│            │            │  Socket.IO)  │           │  LangGraph)   │        │          │
└────────────┘            └──────────────┘           └───────────────┘        └──────────┘
```

---

## 2. Root folder

```
GrubGroup/
├── README.md              # Project overview
├── PROJECT_STRUCTURE.md   # This file — explains the folder layout
├── .gitignore             # Shared ignores (node_modules, .env / .env.*, build output, OS files)
├── frontend/              # React + TypeScript + Vite web app  (see §4)
├── backend/               # Unified backend: gateway + ai_service  (see §3)
├── planning/              # Product & system design documents
│   ├── project_plan.md
│   ├── project_proposal.md
│   ├── user_stories.md
│   ├── design_ui.md
│   └── README.md
└── reflections/           # Weekly team reflections
    ├── reflection1.md … reflection5.md
    └── README.md
```

---

## 3. Backend root (`backend/`)

The backend is one folder containing **two separate services** that run as separate
processes.

```
backend/
├── README.md          # How the two services fit together
├── gateway/           # Node.js + Express + Socket.IO  (managed with Bun)
└── ai_service/        # Python + FastAPI               (managed with uv)
```

### 3a. `backend/gateway/` — Real-Time Service (Node.js + Express)

The **frontend-facing** service. Responsibilities: Better Auth (cookie sessions), Socket.IO
live chat/session sync, Prisma writes for frontend data, and proxying AI/RAG requests to
`ai_service`. Auth is **Better Auth**, mounted at `/api/auth/*` directly in `app.js` — there is
no `auth.routes.js` / `auth.controller.js` / `jwt.service.js`.

Filenames are **camelCase with a role suffix** (`*Routes.js`, `*Controller.js`, `*Middleware.js`);
service clients are `*Client.js`. There is no dotted `*.routes.js` / `*.service.js` convention.

```
gateway/
├── package.json                  # Deps (Express, Socket.IO, better-auth, @prisma/client, axios, pg) + Bun scripts
├── .env.example                  # Sample environment variables
├── Dockerfile  fly.toml          # Container + Fly.io deploy config (app `grubgroup-gateway`)
├── server.js                     # Entry point: starts the HTTP + WebSocket server
├── prisma/                       # Prisma schema + migrations (owns the DB DDL + pgvector) + seeds
│   ├── schema.prisma  SCHEMA.md
│   ├── migrations/               # SQL migrations (incl. enable vector extension)
│   ├── generated_restaurants.json  # ~2,000-restaurant seed catalog (OSM-derived, ODbL)
│   └── seed.mjs  seed_groups.mjs
├── scripts/                      # Dev/ops harnesses (not part of the running service)
│   ├── e2e_rest.mjs              # Live REST harness across ~29 endpoints (Better Auth cookies)
│   ├── probe_voice_relay.js      # Voice-relay authorization-guard suite
│   └── backfill_flexible_budget.mjs / .sql   # One-time no-cap budget migration
└── src/
    ├── app.js                    # Express app: mounts Better Auth /api/auth/* (before express.json),
    │                             #   then GET /health (the fly.toml probe), GET /api/me, and /api routes
    ├── lib/
    │   ├── auth.js               # Better Auth config (Prisma adapter, email/password + Google)
    │   └── prisma.js             # Prisma client singleton
    ├── config/
    │   └── index.js              # Loads & validates environment config
    ├── routes/                   # URL → controller mappings
    │   ├── index.js              # Mounts /auth-methods, /geocode, /restaurants, /sessions, /profile,
    │   │                         #   /user, /users, /groups, /events, /voice
    │   ├── restaurantsRoutes.js  # /restaurants — create + embed
    │   ├── sessionsRoutes.js     # /sessions — recommendations + analyze proxy, close, members
    │   ├── profileRoutes.js      # /profile — read/update the caller's Profile
    │   ├── userRoutes.js         # /user — caller identity (GET /me, PATCH /, DELETE /)
    │   ├── usersRoutes.js        # /users — username search (member-picker)
    │   ├── groupsRoutes.js       # /groups — group CRUD + membership
    │   ├── eventsRoutes.js       # /events — the caller's dining history
    │   └── voiceRoutes.js        # /voice — POST /preview (audition a TTS voice from settings)
    ├── controllers/              # Request handlers (the logic per route)
    │   ├── restaurantsController.js  # create Restaurant + embed via ai_service + ::vector write
    │   ├── sessionsController.js     # session lifecycle + AI proxy (recommendations/analyze) + geocode
    │   ├── profileController.js  userController.js  usersController.js
    │   ├── groupsController.js  eventsController.js  authMethodsController.js
    │   ├── voiceController.js    # proxies the voice preview; returns WAV bytes, not JSON
    ├── middleware/               # Cross-cutting request logic
    │   ├── authMiddleware.js     # Better Auth session guard (requireAuth)
    │   └── errorMiddleware.js    # Central error handling
    ├── sockets/                  # Real-time WebSocket logic
    │   ├── index.js              # Socket.IO setup + session-cookie handshake + Postgres adapter
    │   │                         #   (cross-machine broadcast fan-out; skipped when DATABASE_URL is unset)
    │   ├── sessionHandlers.js    # group:join/leave, chat:history, chat:message, group:preview,
    │   │                         #   session:start, typing:*, vote:*
    │   └── voiceHandlers.js      # voice:* binary relay — bridges the browser mic loop to ai_service's voice WS
    ├── services/                 # Outbound clients
    │   ├── aiClient.js           # Talks to the FastAPI ai_service (embed, recommendations, analyze,
    │   │                         #   voice preview — the last one returns audio, not JSON)
    │   ├── geocodeClient.js      # Server-side geocoding (Geocodio) for the host modal
    │   └── voiceClient.js        # Opens a raw WS to ai_service's /voice/session (forwards X-Internal-Secret)
    └── utils/
        └── logger.js             # Logging helper
```

> The AI proxy lives in `sessionsController.js` + `services/aiClient.js`. There is **no**
> `aiRoutes.js` / `aiController.js` (an earlier empty starter pair was removed), and no
> `auth.routes.js` / `jwt.service.js` — Better Auth owns `/api/auth/*` directly in `app.js`.
>
> `session:picks` and `session:confirmed` are broadcast from `sessionsController.js` (they follow
> an HTTP action), not from `sessionHandlers.js` — the socket file handles client-initiated events.

### 3b. `backend/ai_service/` — AI / Data Service (FastAPI)

The Python "brains." Responsibilities: the database (read-side mirror + recommendation/Qa writes),
the AI agents, restaurant search (RAG), and the **server-side voice loop**. The group-chat composer
sends browser-transcribed text; the **session agent chat** runs a wired **cascaded STT→analyze→TTS
voice loop** — a WebSocket in `routes/voice.py` bridging **Deepgram Flux** STT (`ai/voice/stt.py`)
and **Cartesia** TTS (`ai/voice/tts.py`), with catalog-derived STT keyterms (`ai/voice/keyterms.py`),
the selectable-voice allowlist (`ai/voice/voices.py`), and the frame DTOs in `schemas/voice.py`.
Every module in the tree is wired — Prisma (in the gateway) owns the DDL, so this service never
creates tables.

```
ai_service/
├── pyproject.toml / uv.lock / .python-version   # Python project + locked dependencies
├── .env.example / .gitignore / .dockerignore
├── Dockerfile  fly.toml          # Container + Fly.io deploy config (app `grubgroup-ai`)
├── README.md                     # Service-specific setup instructions
├── scripts/                      # Dev/ops tooling (not part of the running service)
│   ├── seed_restaurants.py       # Fills the DB with ~54 mock restaurants (with embeddings)
│   ├── backfill_embeddings.py    # (Re)embeds existing restaurants — e.g. after the embedding-model swap
│   ├── smoke_orchestrator.py     # Direct end-to-end orchestrator graph smoke test
│   ├── demo_orchestrator.py      # Narrated terminal walkthrough of the recommendation pipeline
│   ├── analyze_turn_demo.py      # Conversational analyze-turn demo
│   ├── interactive_session.py    # Interactive session harness
│   ├── verify_budget_ceiling.py  # Offline assertion suite for budget / no-cap semantics
│   ├── measure_analyze_latency.py  # Measures analyze-turn latency (the voice-path budget)
│   ├── probe_extractor_bench.py  # Benchmarks candidate extraction models against the real prompt
│   ├── live_http_gateway_e2e.py  # Live HTTP harness across ai_service + gateway (401/409/200)
│   └── probe_voice_session.py / probe_flux_stt.py / probe_cartesia_tts.py   # Voice-path smoke tests
└── app/                          # The actual application code
    ├── main.py                   # Builds & configures the FastAPI app (the canonical entrypoint)
    ├── core/
    │   └── config.py             # Reads settings from environment (Pydantic Settings)
    ├── db/                       # Database connection & setup
    │   └── session.py            # Async engine + async_session_factory (Prisma owns DDL + pgvector)
    ├── models/                   # Database tables (SQLModel read-side mirror of Prisma)
    │   ├── user.py  profile.py  session.py  session_member.py     # core
    │   ├── restaurant.py  qa.py  group.py                         # restaurant has vector(1024) embedding
    │   ├── recommendation.py  recommendation_item.py
    │   └── timestamps.py  enums.py                                # utcnow helper; Role/MessageType
    ├── schemas/                  # Request/response shapes (Pydantic)
    │   ├── ai.py                 # Embed / Recommendation / Analyze DTOs
    │   └── voice.py              # Voice-loop frame DTOs (ready/caption/turn_result/… — wired)
    ├── api/                      # The HTTP endpoints
    │   ├── deps.py               # require_internal_secret (the X-Internal-Secret guard)
    │   └── v1/                   # Version 1 of the API (mounted at /api/v1)
    │       ├── router.py         # Mounts three route files: health + ai + voice
    │       └── routes/
    │           ├── health.py         # Is the service up?
    │           ├── ai.py             # POST /embed, POST /sessions/{id}/recommendations,
    │           │                     #   POST /sessions/{id}/analyze, POST /analyze
    │           └── voice.py          # WS /voice/session — cascaded STT→analyze→TTS voice loop;
    │                                 #   POST /voice/preview — one-shot WAV of a fixed line in a
    │                                 #   chosen voice (settings audition), cached per voice
    ├── services/                 # Business logic (multi-step workflows)
    │   ├── recommendation_service.py  # orchestrator wrapper: guard → pipeline → persist
    │   ├── session_service.py         # analyze_member_turn (in-session Qa)
    │   ├── profile_service.py         # persist_qa / persist_profile + diffs
    │   └── geocode.py                 # address → lat/lon helper
    ├── crud/                     # Direct database read/write helpers
    │   ├── session.py            # Reads members/profiles/Qa; host-gated upsert_qa_signals (WRITE)
    │   ├── restaurant.py         # Reads + counts (similarity search lives in ai/rag/retriever.py)
    │   ├── recommendation.py     # WRITES Recommendation + RecommendationItem
    │   └── user.py               # Reads Profile; upsert_profile_signals (update-only)
    └── ai/                       # The AI subsystem (feature-sliced)
        ├── llm/                  # Talking to language models
        │   ├── client.py         # Chat client — provider chosen by LLM_PROVIDER; shared strip_json_fence
        │   └── prompts.py        # Prompt templates (conversational turn, group re-rank)
        ├── rag/                  # Restaurant search by meaning ("RAG")
        │   ├── embeddings.py     # Turns text into vectors (Perplexity pplx-embed via OpenRouter, 1024-dim)
        │   └── retriever.py      # pgvector cosine search + hard filters (dietary/price/geo)
        ├── agents/               # The AI "personas"
        │   ├── preference_agent.py    # Normalizes one member's Profile → MemberPref
        │   ├── orchestrator_agent.py  # Reconciles the group: retrieve → LLM re-rank → fallback
        │   └── conversation_agent.py  # analyze_turn — parses a member's natural-language turn
        ├── graph/                # Multi-step AI pipeline (LangGraph)
        │   ├── pipeline.py       # StateGraph: fan-out preference → orchestrator
        │   └── state.py          # Typed state passed between steps
        ├── voice/                # Server voice loop (wired — session agent chat)
        │   ├── stt.py            # Speech → text (Deepgram Flux, streaming WS)
        │   ├── tts.py            # Text → speech (Cartesia sonic-3.5, HTTP SSE)
        │   ├── keyterms.py       # Catalog-derived STT keyterms (biases Flux toward restaurant names)
        │   └── voices.py         # SELECTABLE_VOICES — allowlist validating the client's voice_id
        └── taxonomy.py  geo.py  hours.py  budget.py   # cuisine taxonomy; geo helpers;
                                  #   open/closed hours filter; the NO_CAP budget sentinel
```

---

## 4. Frontend root (`frontend/`)

React + TypeScript app built with **Vite**, styled with **TailwindCSS**, managed with
**Bun**.

> **Status:** The frontend is a **full build-out** (not a Vite starter). It uses Better Auth
> for auth and **react-router v8** for navigation — import from `react-router`, since
> `react-router-dom` was removed in v8. Styling is TailwindCSS v4, wired via `@tailwindcss/vite`
> + `@import "tailwindcss"` (`@theme` tokens in `index.css`; no `tailwind.config.js`).

```
frontend/
├── package.json          # Deps (React 19, axios, socket.io-client, zustand, better-auth, tailwindcss v4, …)
├── bun.lock              # Locked dependency versions
├── vite.config.ts        # Vite config — registers react() + @tailwindcss/vite(); dev proxy to gateway
├── tsconfig*.json        # TypeScript configuration
├── eslint.config.js      # Linting rules
├── index.html            # HTML entry point
├── README.md
├── scripts/              # One-off asset tooling (not part of the build)
│   └── fetch-cuisine-images.ts   # (re)builds public/media/cuisines from Openverse; `bun run` it
├── public/               # Static files served as-is (favicon.svg, worklets/pcm-recorder.js)
│   └── media/cuisines/   # COMMITTED cuisine stock photos, 5 per pool, served at
│                         #   /media/cuisines/<key>/<key>-N.jpg on the deployed site.
│                         #   Plus ATTRIBUTION.md + credits.json (CC BY needs credit) and
│                         #   rejected.json (Openverse ids a review pass ruled out).
└── src/                  # Application source (see §4a)
    ├── main.tsx          # App entry point (mounts React inside <BrowserRouter>)
    ├── App.tsx           # The route tree (<Routes>) — layout routes + every path
    ├── index.css         # Tailwind import + @theme design tokens
    └── assets/           # unset-table.svg (the empty/404 illustration)
```

### 4a. `src/` layout (implemented)

The feature structure below **exists and is populated** — build new work into these folders.

```
src/
├── api/            # HTTP calls to the gateway via axios (live only — no mock layer)
│   └── authApi.ts  sessionApi.ts  eventsApi.ts  restaurantsApi.ts
│       profileApi.ts  groupsApi.ts  userApi.ts  usersApi.ts  voiceApi.ts
├── pages/          # Full screens (one per route)
│   ├── public/         # LandingPage → / ; NotFoundPage → * (catch-all)
│   ├── auth/           # AuthForm (Better Auth sign-in/up + Google)  → /login, /signup
│   └── member/         # GroupsIndex → /groups (redirects on desktop, renders GroupsPage —
│       │               #   the list/zero-state — on mobile); GroupChatPage → /groups/:groupId;
│       │               #   ExplorePage → /explore; EventsPage → /events[/:eventId];
│       │               #   ProfilePage, ProfileEditPage; SettingsPage → /settings
│       ├── onboarding/     # Onboarding1-3 + OnboardingCuisines  → /onboarding/*
│       └── session/        # AgentChatPage, TopPicksPage
│                           #   → /groups/:groupId/sessions/:sessionId[/done|/picks]
├── components/     # reusable UI pieces
│   ├── ui/             # Design-system primitives (Button, Input, Card, Modal, …) + index.ts
│   ├── layout/         # Route layouts: RootLayout (session mirror + splash), RequireAuth,
│   │                   #   PublicOnly (post-auth forward), AuthFlowShell (keeps the brand panel
│   │                   #   mounted across sign-in/sign-up/onboarding so the right pane slides).
│   │                   #   Plus AppSidebar, BrandPanel, AppSplash, AccountMenu, and the mobile
│   │                   #   shell: BottomTabBar, MobileHeader, MobileActionSheet
│   ├── session/        # Session/chat widgets (HostSessionModal, SessionTopBar, SessionTimer,
│   │                   #   GroupMessageRow, ChatStream, ChatMessage, SessionCard, MemberRoster,
│   │                   #   GroupList, GroupsSidebar, GroupDetailPanel, GroupProgressPanel,
│   │                   #   NewGroupModal, NotedSoFarPanel, SegmentedProgress, TypingIndicator,
│   │                   #   AgentAvatar, AgentTypingBubble, MessagesLoader, PicksLoader,
│   │                   #   MobileSessionStrip)
│   ├── restaurant/     # RankedRestaurantCard (reused by TopPicksPage; ephemeral voting),
│   │                   #   RestaurantExploreCard, RestaurantDetailModal, ExploreFilters,
│   │                   #   LikedPlacesPanel, LikeStarButton, RestaurantHeader, TagRow,
│   │                   #   MenuList (placeholder) + MenuItemRow, and RestaurantImage (the random
│   │                   #   cuisine-photo banner, used by every restaurant surface incl. Events)
│   ├── profile/        # CuisineTriStatePicker, PreferenceTag
│   └── voice/          # VoiceComposer — one composer, two paths (Web Speech dictation for group
│                       #   chat; hands-free server voice loop for the session agent chat).
│                       #   VoicePreviewButton — auditions a TTS voice from Settings
├── hooks/          # Routing: useGroupId, useSessionId (decode a name-42 slug), useBindSession
│                   #   (rebinds a group's live session on a cold URL entry).
│                   #   Sync: useSocket, useGroupSync, useSessionSync, useSessionCountdown.
│                   #   Voice: useVoiceInput (Web Speech), useVoiceSession (server loop).
│                   #   Visuals: useCuisineImage (holds one random cuisine photo per mount).
│                   #   Plus useExploreFilters, usePlacesInput, useAnchoredPosition, useMediaQuery,
│                   #   useIsMobile, useNewItemIds, useScrollToBottom, useScrollLock,
│                   #   useDismissOnBack, useCreateGroup, useSignOut
├── stores/         # 11 zustand stores: auth, session, groupChat, chat, event, eventList,
│                   #   profile, groups, restaurant, theme, voicePref.
│                   #   (No nav store — the URL owns navigation.)
├── lib/            # Client setup: axios, socket, authClient (Better Auth), env, motion
├── types/          # Shared TypeScript types (user, profile, session, recommendation, analyze,
│                   #   group, groupChat, chat, restaurant, menu, qa, voice, …)
├── utils/          # Small helpers (cn.ts, hours.ts — TS mirror of ai_service app/ai/hours.py,
│                   #   distance.ts, formatBudget.ts, price.ts, password.ts, memberName.ts,
│                   #   timeAgo.ts, slug.ts — the name-42 route slugs)
└── constants/      # App-wide constants (dietary.ts, memberColors.ts — the shared avatar palette,
                    #   agentChat.ts, mobileNav.ts, theme.ts, voices.ts, restaurantVisuals.ts,
                    #   cuisineImages.ts — cuisine tag → photo pool mapping)
```

---

## 5. Quick reference — "Where do I put…?"

| I want to add…                | It goes in…                                                             |
| ----------------------------- | ----------------------------------------------------------------------- |
| A new API endpoint (Python)   | `backend/ai_service/app/api/v1/routes/`                                 |
| A new database table          | `backend/ai_service/app/models/`                                        |
| AI agent / prompt logic       | `backend/ai_service/app/ai/`                                            |
| A real-time (WebSocket) event | `backend/gateway/src/sockets/`                                          |
| Auth (sign-in/up, OAuth)      | `backend/gateway/src/lib/auth.js` (Better Auth; mounted in `app.js`)    |
| An AI-proxy route (Node)      | `backend/gateway/src/routes/` + `controllers/` + `services/aiClient.js` |
| A new screen/page (React)     | `frontend/src/pages/` + a `<Route>` in `frontend/src/App.tsx`            |
| A reusable UI element (React) | `frontend/src/components/`                                              |
| A static image/asset          | `frontend/public/media/` (served verbatim at `/media/…` in prod)        |
| A product/planning doc        | `planning/`                                                             |
