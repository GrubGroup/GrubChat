// Socket.IO handlers for the voice turn-loop: relay a member's mic audio to the
// ai_service voice WS and stream captions / analyzed turns / TTS audio back.
//
// This is the FIRST stateful per-socket resource in the codebase — it holds an
// open upstream WS (which bills Deepgram per minute) for the life of a voice
// session — so cleanup is load-bearing: `voice:stop` AND `disconnect` both tear
// the upstream down, and a leaked socket bills silently. There is no existing
// disconnect-cleanup pattern to copy (`rg disconnect src/` = 0 hits).
//
// PRIVACY: the agent chat is private ("Only you can see this"). Every downstream
// frame goes back with `socket.emit` (this one socket), NEVER `io.to(room)` —
// broadcasting a member's transcript to the group room would leak it. This is the
// one place the room-broadcast pattern must NOT be copied.
import { prisma } from '../lib/prisma.js';
import { openVoiceUpstream } from '../services/voiceClient.js';

/**
 * Wire the voice events for a single connected socket. The socket is already
 * authenticated (sockets/index.js `io.use` resolved the Better Auth cookie into
 * socket.data.userId — a STRING).
 * @param {import('socket.io').Server} _io
 * @param {import('socket.io').Socket} socket
 */
const registerVoiceHandlers = (_io, socket) => {
  // session.host_user_id / sessionMember.user_id are Int; the handshake stored
  // the id as a STRING. Coerce ONCE — a raw string throws a Prisma Int-validation
  // error instead of cleanly rejecting, so also guard NaN below.
  const userId = Number(socket.data.userId);

  // The single upstream connection for this socket's active voice session, or
  // null when idle. Only one at a time — a second `voice:start` closes the first.
  let upstream = null;

  const teardown = () => {
    if (upstream) {
      upstream.close();
      upstream = null;
    }
  };

  socket.on('voice:start', async ({ sessionId } = {}) => {
    const sid = Number(sessionId);
    if (!Number.isInteger(sid) || sid <= 0) {
      socket.emit('voice:error', { message: 'invalid sessionId' });
      return;
    }
    if (!Number.isInteger(userId)) {
      socket.emit('voice:error', { message: 'unauthenticated' });
      return;
    }

    try {
      // Load the session for BOTH the closed_at check and the authoritative
      // group_id (never trust a client-supplied groupId). The copied analyzeTurn
      // guard does NOT check closed_at — but opening a billed mic on a CLOSED
      // session (whose Qa rows are already deleted) is exactly the leak to avoid.
      const session = await prisma.session.findUnique({
        where: { id: sid },
        select: { closed_at: true, group_id: true },
      });
      if (!session) {
        socket.emit('voice:error', { message: 'session not found' });
        return;
      }
      if (session.closed_at) {
        socket.emit('voice:error', { message: 'session is closed' });
        return;
      }

      // Membership guard (mirrors the REST analyzeTurn/submitQa check): only a
      // session member may open a mic. The composite key needs Int user_id.
      const member = await prisma.sessionMember.findUnique({
        where: { session_id_user_id: { session_id: sid, user_id: userId } },
      });
      if (!member) {
        socket.emit('voice:error', { message: 'not a session member' });
        return;
      }
    } catch (err) {
      console.error('voice:start guard failed', err);
      socket.emit('voice:error', { message: 'could not start voice session' });
      return;
    }

    // Re-open cleanly if a previous session was still up.
    teardown();

    upstream = openVoiceUpstream(sid, userId, {
      onOpen: () => socket.emit('voice:ready', { sessionId: sid }),
      // Control frames from ai_service -> the browser, private to THIS socket.
      onText: (frame) => socket.emit('voice:frame', frame),
      // Binary TTS audio -> the browser as an ArrayBuffer (Socket.IO handles the
      // binary encoding). Private to this socket.
      onAudio: (pcm) => socket.emit('voice:audio', pcm),
      onClose: () => {
        socket.emit('voice:closed', { sessionId: sid });
        upstream = null;
      },
      onError: (err) => {
        // Report on OUR own guard/relay state, not any upstream HTTP status —
        // under Bun a 403/404/machine-down are indistinguishable here.
        console.error('voice upstream error', err?.message ?? err);
        socket.emit('voice:error', { message: 'voice service unavailable' });
      },
    });
  });

  // Mic audio: forward each chunk upstream as a binary frame. High-frequency
  // (80 ms) — keep it lean; drop silently if the upstream isn't up.
  socket.on('voice:audio', (chunk) => {
    if (upstream?.isOpen()) upstream.sendAudio(chunk);
  });

  // Control frames from the browser (mute / stop / re-seed start) -> upstream.
  socket.on('voice:control', (frame) => {
    if (upstream?.isOpen() && frame && typeof frame === 'object') {
      upstream.sendControl(frame);
    }
  });

  socket.on('voice:stop', () => teardown());

  // Disconnect cleanup is CRITICAL: a leaked upstream WS keeps a Deepgram stream
  // (billed per minute) open forever. A throw inside a disconnect handler is
  // silently swallowed, so keep teardown() total and defensive.
  socket.on('disconnect', () => {
    try {
      teardown();
    } catch (err) {
      console.error('voice disconnect cleanup failed', err);
    }
  });
};

export { registerVoiceHandlers };
