// Socket.IO server setup and session-authenticated identity handshake.
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/postgres-adapter';
import pg from 'pg';
import { config } from '../config/index.js';
import { auth } from '../lib/auth.js';
import { registerSessionHandlers } from './sessionHandlers.js';

/**
 * Wire a Postgres adapter so room broadcasts (chat/typing/session) fan out
 * across every gateway machine — Socket.IO's default in-memory rooms only reach
 * clients on the emitting process, which splits chat during a redeploy overlap
 * (or any scale-out). Uses LISTEN/NOTIFY + a `socket_io_attachments` table.
 *
 * Best-effort: if the pool can't be created we log and skip the adapter rather
 * than crash the server — single-machine still works without it.
 * @param {import('socket.io').Server} io
 */
const attachPostgresAdapter = async (io) => {
  if (!config.DATABASE_URL) return;
  // Low `max`: this pool is separate from Prisma's and Render's connection cap
  // is shared. rejectUnauthorized:false — Render's PG cert chain isn't in the
  // default CA bundle. This pool is adapter-only (not the app's Prisma client).
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5,
  });
  pool.on('error', (err) => console.error('socket.io pg pool error', err));
  try {
    // Adapter-owned infra table (payloads too large for a NOTIFY message).
    // Intentionally NOT a Prisma migration — it's transient adapter state, not
    // part of the domain schema. Idempotent, safe to run on every boot.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS socket_io_attachments (
        id          bigserial UNIQUE,
        created_at  timestamptz DEFAULT NOW(),
        payload     bytea
      );
    `);
    io.adapter(createAdapter(pool));
    console.log('Socket.IO Postgres adapter attached');
  } catch (err) {
    console.error('Failed to attach Socket.IO Postgres adapter; continuing single-node', err);
  }
};

/**
 * Attach a Socket.IO server to the given HTTP server and wire chat handlers.
 * Returns the io instance.
 * @param {import('http').Server} httpServer
 */
const createSocketServer = (httpServer) => {
  const io = new Server(httpServer, {
    cors: { origin: config.CORS_ORIGIN, credentials: true },
  });

  // Fan broadcasts across machines (fire-and-forget; single-node works meanwhile).
  void attachPostgresAdapter(io);

  // Authenticate every connection from the Better Auth session cookie, which the
  // browser sends on the handshake (client connects with withCredentials). The
  // security-sensitive identity (userId, role) comes from the verified session —
  // never from client-supplied values. `name` is a cosmetic display label only.
  io.use(async (socket, next) => {
    const cookie = socket.handshake.headers.cookie;
    if (!cookie) {
      return next(new Error('unauthorized'));
    }
    try {
      // getSession reads the session cookie from the forwarded headers.
      const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
      if (!session) {
        return next(new Error('unauthorized'));
      }
      socket.data.userId = session.user.id;
      socket.data.role = session.user.role;
      socket.data.name = socket.handshake.auth?.name ?? null;
      // Verified OAuth photo (Better Auth image → avatar_url), carried on typing
      // presence so a typer's avatar matches their chat/session avatar. From the
      // session, not client-supplied. Null for email/password users.
      socket.data.avatarUrl = session.user.image ?? null;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    // Join a per-user room so membership changes (added to / removed from a group)
    // can reach THIS user regardless of which group rooms they've joined — a newly
    // added member isn't in the group's room yet, so a group-scoped emit can't find
    // them. userId is a string on socket.data (Better Auth); coerce to match the Int
    // used as the emit target (see groupsController `user:${id}`).
    const userId = Number(socket.data.userId);
    if (Number.isInteger(userId)) socket.join(`user:${userId}`);
    registerSessionHandlers(io, socket);
  });

  return io;
};

export { createSocketServer };
