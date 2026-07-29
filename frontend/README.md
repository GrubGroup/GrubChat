# GrubGroup — Frontend

The browser app for GrubGroup: a React 19 single-page application routed with react-router, styled with TailwindCSS v4, managed with Bun. Users authenticate via Better Auth (cookie sessions), join group chats, talk (voice or text) to their AI preference agent during a session, and view the shared restaurant picks the host confirms into a group Event.

This frontend talks exclusively to the **gateway** service (REST + Socket.IO) and never calls `ai_service` directly.

## Stack

| Library                  | Purpose                                                                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| React 19                 | Component-based UI                                                                                                               |
| TypeScript               | Type-safe codebase                                                                                                               |
| Vite 8                   | Dev server + build tool                                                                                                          |
| TailwindCSS 4            | Utility-first styling via `@tailwindcss/vite` plugin (v4 config-less: tokens in `@theme` blocks in CSS, no `tailwind.config.js`) |
| react-router 8           | Routing — `<BrowserRouter>` + a `<Routes>` tree; import from `react-router` (not `react-router-dom`, removed in v8)              |
| zustand                  | Client-side data/session state stores (**not** navigation — the URL owns that)                                                   |
| better-auth              | Auth client (`useSession`, `signIn`/`signUp`/`signOut`), email/password + Google OAuth                                           |
| axios                    | HTTP calls to the gateway (`withCredentials: true` for cookie sessions)                                                          |
| socket.io-client         | Live group chat, session sync, and the binary voice relay via the gateway                                                        |
| react-speech-recognition | Browser speech-to-text (group-chat dictation)                                                                                    |
| framer-motion            | Animation and transitions                                                                                                        |

Managed with **Bun** (ESM: `"type": "module"`).

## Commands

```bash
bun install      # Install dependencies
bun run dev      # Vite dev server on port 5173
bun run build    # tsc -b && vite build
bun run lint     # eslint .
bun run preview  # Preview the production build
```

## Key conventions

- **Routing** — react-router v8 in declarative mode (`<BrowserRouter>` + `<Routes>` in `App.tsx`). Import from **`react-router`**, not `react-router-dom` — that package was removed in v8. See the route map below.
- **PascalCase `*.tsx`** for components; **camelCase `*.ts`** for hooks, stores, utils, api modules.
- **Strict TypeScript** — `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `noFallthroughCasesInSwitch`. Keep imports type-only where required (`import type { … }`).
- **Live-gateway only** — There is no mock layer (the old `VITE_USE_MOCK` switch and `api/mock/` were removed). The app always runs against the live gateway. Auth is mandatory: the `RequireAuth` layout route guards every non-public route on the Better Auth session.
- **Gateway origin** — `VITE_GATEWAY_URL` (default `http://localhost:4000`) points at the gateway. The Vite dev server proxy forwards `/api` requests to the gateway; `CORS_ORIGIN` in the gateway's `.env` must match the Vite dev origin (`:5173`).
- **Auth flow** — `lib/authClient.ts` points at the gateway. `signIn`/`signUp`/Google OAuth hit the gateway's `/api/auth/`*, which sets an httpOnly session cookie (first-party via the Vite dev proxy). The app reads the session with `useSession()` and mirrors it into `authStore`; axios uses `withCredentials: true` so the cookie rides along on every request. No client-side JWT.

## Routes

```
/                                          Landing page (public; signed-in visitors are forwarded in)
/login  ·  /signup                         Credential forms
/onboarding                                Onboarding entry → step 1 (where sign-up lands)
/onboarding/dietary                        Step 1 of 4 — dietary needs
/onboarding/cuisines                       Step 2 of 4 — cuisines to like / avoid
/onboarding/budget                         Step 3 of 4 — usual budget
/onboarding/location                       Step 4 of 4 — default location, then save
/groups                                    Your groups (redirects to the most recent one, if any)
/groups/:groupId                           Group chat
/groups/:groupId/sessions/:sessionId       Your private AI agent chat
/groups/:groupId/sessions/:sessionId/done  Finished — waiting on the rest of the group
/groups/:groupId/sessions/:sessionId/picks The group's top picks
/events  ·  /events/:eventId               Your booked events
/profile  ·  /profile/edit                 Profile view / edit
```

Four **layout routes** structure the tree: `RootLayout` (mirrors the Better Auth session into
`authStore`), `PublicOnly` (forwards a signed-in visitor off the public pages), `RequireAuth`
(bounces a signed-out visitor to `/login`), and `AuthFlowShell`, which keeps the brand panel
mounted across sign-in / sign-up / onboarding so the right pane cross-slides between them.

Group and session ids come from the URL via `useGroupId()` / `useSessionId()`. Session state is
keyed by **group** — a group has at most one open session — so `:sessionId` is validated against
the store rather than used as a lookup key, and `useBindSession()` restores an in-progress session
when a session URL is opened cold (a refresh or a pasted link).

## Deployment

Client-side routing requires the host to serve `index.html` for **any** unknown path — otherwise
a deep link like `/groups/12` works via in-app navigation but 404s on refresh or when pasted.

- `bun run dev` and `bun run preview` already do this (Vite's default `appType: 'spa'`).
- **Render static site** — needs an explicit rule: Redirects/Rewrites → source `/*`, destination
  `/index.html`, action **Rewrite**. In a `render.yaml` Blueprint the equivalent is
  `routes: [{ type: rewrite, source: /*, destination: /index.html }]`. Render does **not** read a
  `public/_redirects` file, so that is not a substitute.
- **Render web service** running `bun run preview` — nothing to configure; Vite already serves the
  fallback.

To check: deploy, then hard-refresh a deep link such as `/groups/12/sessions/48`. It should load the
app, not a 404.

## Project layout

```
src/
├── main.tsx          # App entry point (mounts React inside <BrowserRouter>)
├── App.tsx           # The route tree (<Routes>) — layout routes + every path
├── index.css         # Tailwind import + @theme design tokens
├── api/              # HTTP calls to the gateway via axios
│   ├── sessionApi.ts  eventsApi.ts  restaurantsApi.ts  profileApi.ts
│   ├── authApi.ts  groupsApi.ts  userApi.ts  usersApi.ts
│   └── (no mock layer)
├── pages/            # Full screens (one per route)
│   ├── auth/         # AuthForm (Better Auth sign-in/up + Google)
│   ├── public/       # LandingPage
│   └── member/       # GroupsIndex (→ GroupsPage list/zero-state), GroupChatPage, EventsPage, ProfilePage, ProfileEditPage
│       ├── onboarding/     # Onboarding1-3 + OnboardingCuisines
│       └── session/        # AgentChatPage, TopPicksPage
├── components/       # Reusable UI pieces
│   ├── ui/           # Design-system primitives (Button, Input, Card, Modal, …) + index.ts
│   ├── layout/       # Route layouts (RootLayout, RequireAuth, PublicOnly, AuthFlowShell) + AppSidebar,
│   │                 #   BrandPanel, AppSplash, AccountMenu + mobile chrome (BottomTabBar, MobileHeader, MobileActionSheet)
│   ├── session/      # HostSessionModal, SessionTopBar, SessionTimer, GroupMessageRow, ChatStream, SessionCard,
│   │                 #   GroupList, GroupDetailPanel, MobileSessionStrip, …
│   ├── restaurant/   # RankedRestaurantCard (ephemeral voting), MenuList (placeholder), RestaurantHeader, TagRow, MenuItemRow
│   ├── profile/      # CuisineTriStatePicker, PreferenceTag
│   └── voice/        # VoiceComposer — one composer, two paths (Web Speech dictation + hands-free server loop)
├── hooks/            # Routing (useGroupId, useSessionId, useBindSession); sync (useSocket, useGroupSync,
│                     #   useSessionSync, useSessionCountdown); voice (useVoiceInput, useVoiceSession);
│                     #   usePlacesInput, useMediaQuery, useIsMobile, useScrollLock, useDismissOnBack, useCreateGroup, useSignOut, …
├── stores/           # 9 zustand stores: auth, session, groupChat, chat, event, eventList, profile, groups, restaurant
├── lib/              # axios, socket, authClient (Better Auth), env, motion
├── types/            # Shared TypeScript types (user, profile, session, recommendation, analyze, group, restaurant, voice, …)
├── utils/            # cn.ts, hours.ts (TS mirror of ai_service app/ai/hours.py), slug.ts (name-42 route slugs), …
└── constants/        # dietary.ts, memberColors.ts, agentChat.ts, mobileNav.ts
```
