// Stage 6 verification — the gateway voice relay's authorization guards.
//
// The headline assertion (per the plan): a NON-MEMBER is rejected on the
// gateway's OWN Prisma membership guard — a `voice:error` emitted to the browser
// BEFORE any upstream WS is opened — NOT on an upstream WS status code. Under Bun
// a 403 / 404 / machine-down upstream handshake all surface identically as
// `close 1002 "Expected 101 status code"`, so upstream status is unreadable; the
// gateway must enforce membership itself. This script proves it does, and it runs
// WITHOUT ai_service being up (the guard rejects before the relay is opened).
//
// It also checks the net-new guards the copied analyzeTurn controller lacks:
// invalid sessionId, unknown session, and the closed-session rejection (opening a
// billed mic on a closed session whose Qa rows are already deleted is the leak to
// avoid). The one ai_service-dependent check (a member reaching `voice:ready`) is
// SKIPPED when ai_service is unreachable rather than failing the suite.
//
// Requires a running gateway + Postgres (same preconditions as e2e_rest.mjs).
//   cd backend/gateway && bun run scripts/probe_voice_relay.js
//
// Env: GATEWAY_URL (default http://localhost:4000),
//      AI_SERVICE_URL (default http://localhost:8000).
//
// socket.io-client isn't a gateway dependency; borrow the frontend's copy
// (v4.8.x, protocol-compatible). Run `bun install` in frontend/ first.

const GATEWAY_URL = (process.env.GATEWAY_URL || 'http://localhost:4000').replace(/\/$/, '');
const AI_SERVICE_URL = (process.env.AI_SERVICE_URL || 'http://localhost:8000').replace(/\/$/, '');

// Resolved relative to this file so it works from any clone location.
const FRONTEND_CLIENT = new URL(
  '../../../frontend/node_modules/socket.io-client/build/cjs/index.js',
  import.meta.url,
).href;
const { io } = await import(FRONTEND_CLIENT);

const TAG = 'voicerelay';
const PASSWORD = 'e2e-Password-123';

let passed = 0;
let failed = 0;
const failures = [];

const assert = (label, cond, detail = '') => {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    failures.push(`${label}${detail ? `: ${detail}` : ''}`);
    console.log(`  ✗ ${label}${detail ? `: ${detail}` : ''}`);
  }
};

// ---- REST cookie jar (lifted verbatim from e2e_rest.mjs) --------------------
class Client {
  constructor() {
    this.cookies = new Map();
  }

  #storeSetCookies(res) {
    const raw =
      typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [res.headers.get('set-cookie')].filter(Boolean);
    for (const line of raw) {
      const [pair] = line.split(';');
      const idx = pair.indexOf('=');
      if (idx === -1) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (value === '' || value === 'deleted') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async request(method, path, body) {
    const headers = {};
    const cookie = this.cookieHeader();
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${GATEWAY_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    this.#storeSetCookies(res);
    let data = null;
    const text = await res.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { status: res.status, data };
  }

  get(path) {
    return this.request('GET', path);
  }
  post(path, body) {
    return this.request('POST', path, body);
  }
  patch(path, body) {
    return this.request('PATCH', path, body);
  }
}

const authNewUser = async (suffix, displayName) => {
  const client = new Client();
  const email = `${TAG}_${suffix}@example.test`;
  const signUp = await client.post('/api/auth/sign-up/email', {
    email,
    password: PASSWORD,
    name: displayName,
  });
  if (signUp.status !== 200) {
    const signIn = await client.post('/api/auth/sign-in/email', { email, password: PASSWORD });
    if (signIn.status !== 200) {
      throw new Error(`auth failed for ${email}: sign-up ${signUp.status}, sign-in ${signIn.status}`);
    }
  }
  const me = await client.get('/api/me');
  if (me.status !== 200) throw new Error(`/api/me failed for ${email}: ${me.status}`);
  return { client, id: Number(me.data.user.id), username: me.data.user.username };
};

// Gateway health is at /health; ai_service's is under the versioned prefix
// (/api/v1/health) — pass the right path per service.
const isReachable = async (url, path = '/health') => {
  try {
    const res = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
};

// ---- Socket helpers ---------------------------------------------------------
// The io.use guard authenticates from the Better Auth session COOKIE on the
// handshake (not socket.auth). In Node/Bun, socket.io-client forwards
// `extraHeaders` on the transport handshake, so replay the REST cookie there.
const connectSocket = (client) =>
  new Promise((resolve, reject) => {
    const socket = io(GATEWAY_URL, {
      transports: ['websocket', 'polling'],
      extraHeaders: { Cookie: client.cookieHeader() },
      forceNew: true,
    });
    const t = setTimeout(() => reject(new Error('socket connect timeout')), 8000);
    socket.on('connect', () => {
      clearTimeout(t);
      resolve(socket);
    });
    socket.on('connect_error', (e) => {
      clearTimeout(t);
      reject(new Error(`connect_error: ${e.message}`));
    });
  });

// Emit voice:start and race the possible outcomes; resolve with a tagged result.
const startAndAwait = (socket, sessionId, ms = 6000) =>
  new Promise((resolve) => {
    const done = (result) => {
      clearTimeout(timer);
      socket.off('voice:ready', onReady);
      socket.off('voice:error', onError);
      socket.off('voice:closed', onClosed);
      resolve(result);
    };
    const onReady = (p) => done({ kind: 'ready', payload: p });
    const onError = (p) => done({ kind: 'error', payload: p });
    const onClosed = (p) => done({ kind: 'closed', payload: p });
    const timer = setTimeout(() => done({ kind: 'timeout' }), ms);
    socket.on('voice:ready', onReady);
    socket.on('voice:error', onError);
    socket.on('voice:closed', onClosed);
    socket.emit('voice:start', { sessionId });
  });

// ---- Suite ------------------------------------------------------------------
const run = async () => {
  if (!(await isReachable(GATEWAY_URL))) {
    console.error(`Gateway not reachable at ${GATEWAY_URL}. Start it with:\n  bun run dev\n`);
    process.exit(2);
  }
  const aiUp = await isReachable(AI_SERVICE_URL, '/api/v1/health');
  console.log(`ai_service ${aiUp ? 'IS' : 'is NOT'} reachable at ${AI_SERVICE_URL}` +
    `${aiUp ? '' : ' — the member happy-path check will be skipped'}`);

  // Host (alice) + member (bob) + outsider (carol).
  console.log('\n== Setup: users, group, session ==');
  const alice = await authNewUser('alice', 'Voice Alice');
  const bob = await authNewUser('bob', 'Voice Bob');
  const carol = await authNewUser('carol', 'Voice Carol');
  assert('three users authenticated', Number.isInteger(alice.id) && Number.isInteger(bob.id) && Number.isInteger(carol.id));

  const gCreate = await alice.client.post('/api/groups', { name: 'Voice Crew' });
  const groupId = gCreate.data?.id;
  assert('group created', gCreate.status === 201 && Number.isInteger(groupId), `status ${gCreate.status}`);
  await alice.client.post(`/api/groups/${groupId}/members`, { username: bob.username });

  const sCreate = await alice.client.post('/api/sessions', {
    group_id: groupId,
    time_limit: 30,
    occasion: 'Voice relay test',
    scheduled_for: '2026-08-01T19:30:00.000Z',
    location_address: 'Downtown San Francisco, CA',
  });
  const sessionId = sCreate.data?.id;
  assert('open session created', sCreate.status === 201 && Number.isInteger(sessionId), `status ${sCreate.status}`);

  // Connect all three as authenticated sockets.
  const [aliceSock, bobSock, carolSock] = await Promise.all([
    connectSocket(alice.client),
    connectSocket(bob.client),
    connectSocket(carol.client),
  ]);
  assert('all three sockets connected (cookie handshake)', true);

  // --- HEADLINE: non-member rejected on the gateway's OWN guard ---
  console.log('\n== Guard: non-member rejection (gateway Prisma guard, no upstream) ==');
  const carolRes = await startAndAwait(carolSock, sessionId);
  assert(
    'outsider voice:start -> voice:error on our guard (not an upstream status)',
    carolRes.kind === 'error' && /not a session member/i.test(carolRes.payload?.message ?? ''),
    `got ${carolRes.kind} ${JSON.stringify(carolRes.payload)}`,
  );

  // --- Net-new guards the copied analyzeTurn controller lacks ---
  console.log('\n== Guard: invalid + unknown session ==');
  const badIdRes = await startAndAwait(bobSock, 0);
  assert(
    'invalid sessionId (0) -> voice:error invalid',
    badIdRes.kind === 'error' && /invalid sessionId/i.test(badIdRes.payload?.message ?? ''),
    `got ${badIdRes.kind} ${JSON.stringify(badIdRes.payload)}`,
  );
  const missingRes = await startAndAwait(bobSock, 99999999);
  assert(
    'unknown sessionId -> voice:error not found',
    missingRes.kind === 'error' && /not found/i.test(missingRes.payload?.message ?? ''),
    `got ${missingRes.kind} ${JSON.stringify(missingRes.payload)}`,
  );

  // --- closed-session rejection: create a session, close it, then voice:start ---
  console.log('\n== Guard: closed session (billed-mic leak prevention) ==');
  // A restaurant to confirm against, mirroring e2e_rest.mjs's close flow.
  const rCreate = await alice.client.post('/api/restaurants', {
    name: `Voice Diner ${sessionId}`,
    description: 'closed-session guard fixture',
    cuisine_tags: ['thai'],
    dietary_tags: ['vegan'],
    price_avg: 25,
    address: '123 Test St',
    lat: 37.77,
    long: -122.41,
  });
  const restaurantId = rCreate.data?.id;
  const sClosed = await alice.client.post('/api/sessions', {
    group_id: groupId,
    time_limit: 30,
    occasion: 'closed fixture',
    scheduled_for: '2026-08-01T19:30:00.000Z',
    location_address: 'Downtown San Francisco, CA',
  });
  const closedSessionId = sClosed.data?.id;
  let closedReady = false;
  if (Number.isInteger(closedSessionId) && Number.isInteger(restaurantId)) {
    const closeRes = await alice.client.post(`/api/sessions/${closedSessionId}/close`, {
      restaurant_id: restaurantId,
    });
    closedReady = closeRes.status === 200;
  }
  if (closedReady) {
    const closedRes = await startAndAwait(aliceSock, closedSessionId);
    assert(
      'host voice:start on CLOSED session -> voice:error closed',
      closedRes.kind === 'error' && /closed/i.test(closedRes.payload?.message ?? ''),
      `got ${closedRes.kind} ${JSON.stringify(closedRes.payload)}`,
    );
  } else {
    console.log('  ⊘ SKIP closed-session guard: could not close a fixture session');
  }

  // --- member happy path (needs ai_service) ---
  console.log('\n== Member happy path (requires ai_service) ==');
  if (aiUp) {
    const bobRes = await startAndAwait(bobSock, sessionId, 8000);
    assert(
      'member voice:start reaches upstream (voice:ready)',
      bobRes.kind === 'ready' && bobRes.payload?.sessionId === sessionId,
      `got ${bobRes.kind} ${JSON.stringify(bobRes.payload)}`,
    );
    bobSock.emit('voice:stop');
  } else {
    // Even without ai_service, the member must PASS the gateway guard — i.e. NOT
    // be rejected with "not a session member". The upstream then fails to open,
    // surfacing as voice:error "voice service unavailable" or voice:closed.
    const bobRes = await startAndAwait(bobSock, sessionId, 6000);
    const rejectedByOurGuard =
      bobRes.kind === 'error' && /not a session member|invalid|not found|closed/i.test(bobRes.payload?.message ?? '');
    assert(
      'member passes gateway guard (upstream-unavailable, NOT a membership rejection)',
      !rejectedByOurGuard,
      `got ${bobRes.kind} ${JSON.stringify(bobRes.payload)}`,
    );
  }

  aliceSock.disconnect();
  bobSock.disconnect();
  carolSock.disconnect();

  console.log(`\n==== ${passed} passed, ${failed} failed ====`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
};

run().catch((err) => {
  console.error('\nHarness crashed:', err.message);
  process.exit(1);
});
