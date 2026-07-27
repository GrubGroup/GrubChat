// Socket handlers: group chat relay (join/leave + live message broadcast),
// backed by Postgres.
//
// Messages are PERSISTED to the GroupMessage table (Prisma) before being
// broadcast, so a server restart no longer clears history and late joiners
// (or page reloads) get the backlog. On join we replay recent history to the
// joining socket via 'chat:history'; each new 'chat:message' is written then
// echoed to the whole room. Typing presence and session:start remain
// ephemeral (never stored).
import { prisma } from '../lib/prisma.js';

// How many past messages to replay to a socket when it joins a room.
const HISTORY_LIMIT = 50;

/** Room name for a group's chat channel. */
const room = (groupId) => `group:${groupId}`;

/**
 * Map a GroupMessage.message_type to the wire `type` the client renders on.
 * SYSTEM -> a centered divider; SESSION_BLOCK -> a structured picks card;
 * everything else -> a plain text bubble.
 */
const wireType = (messageType) => {
  if (messageType === 'SYSTEM') return 'system';
  if (messageType === 'SESSION_BLOCK') return 'session_block';
  return 'text';
};

/**
 * Shape a persisted GroupMessage row into the camelCase wire message the
 * frontend expects ({ id, groupId, userId, name, text, at, type }). `name`
 * prefers the author's stored display name / username, falling back to the
 * socket's cosmetic handshake label.
 *
 * A SESSION_BLOCK row stores its payload as JSON in `content`; we parse it into
 * a structured `block` field so a reload (chat:history replay) can reconstruct
 * the top-picks card exactly like the live `session:picks` broadcast — the raw
 * JSON is never shown as message text. Malformed JSON degrades to a plain text
 * bubble so a bad row can't break the whole history replay.
 * @param {{ id: number, group_id: number, user_id: number, content: string, message_type?: string, created_at: Date, user?: { display_name?: string|null, username?: string|null } }} row
 * @param {string|null} [fallbackName]
 */
const toWireMessage = (row, fallbackName = null) => {
  let type = wireType(row.message_type);
  let block = null;
  if (type === 'session_block') {
    try {
      block = JSON.parse(row.content);
    } catch {
      // Unparseable block content — fall back to a plain bubble rather than
      // dropping the message or crashing the history replay.
      type = 'text';
    }
  }
  return {
    id: String(row.id),
    groupId: row.group_id,
    userId: row.user_id,
    name: row.user?.display_name ?? row.user?.username ?? fallbackName,
    // SESSION_BLOCK carries its data in `block`; `text` is left empty for it so
    // the client never renders the raw JSON. Other types use `content` as text.
    text: type === 'session_block' ? '' : row.content,
    block,
    at: row.created_at.toISOString(),
    type,
  };
};

/**
 * True when `userId` belongs to `groupId`. Guards persistence + broadcast so we
 * never write a message for a non-member (mirrors the REST membership check in
 * groupsController.js).
 */
const isGroupMember = async (groupId, userId) => {
  if (!Number.isInteger(groupId) || !Number.isInteger(userId)) return false;
  const membership = await prisma.groupMember.findUnique({
    where: { group_id_user_id: { group_id: groupId, user_id: userId } },
  });
  return Boolean(membership);
};

/**
 * Wire the chat events for a single connected socket.
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 */
const registerSessionHandlers = (io, socket) => {
  // The handshake (sockets/index.js) stores session.user.id as a STRING, but
  // GroupMessage.user_id is Int — coerce once so every write/guard uses the Int.
  const userId = Number(socket.data.userId);

  // Groups this socket has PROVEN membership of (verified against the DB in
  // group:join). Rooms are the unit of fan-out, so being in one is what exposes a
  // group's live traffic — this set is the record of who earned that.
  //
  // Used only to gate high-frequency ephemeral relays (typing), which would
  // otherwise cost a DB round-trip per keystroke. Anything that PERSISTS or drives
  // other clients' state re-checks the DB, since membership can be revoked while a
  // socket is still connected.
  const verifiedGroups = new Set();

  // Join a group's room, then replay recent history to THIS socket so a fresh
  // connection (reload / late joiner) sees the existing conversation.
  socket.on('group:join', async ({ groupId }) => {
    if (!Number.isInteger(groupId)) return;

    // Membership FIRST, then join. Joining before the check would put a non-member
    // in the room, and while the history below would still be withheld, they would
    // receive every later broadcast to it — chat:message, session:start/picks/
    // member_done/confirmed, typing. The room IS the boundary, so nothing may enter
    // it unverified.
    if (!(await isGroupMember(groupId, userId))) return;
    verifiedGroups.add(groupId);
    socket.join(room(groupId));

    try {
      const rows = await prisma.groupMessage.findMany({
        where: { group_id: groupId },
        orderBy: { id: 'desc' },
        take: HISTORY_LIMIT,
        include: { user: { select: { display_name: true, username: true } } },
      });
      // Query is newest-first for the LIMIT; send oldest-first for rendering.
      const messages = rows.reverse().map((row) => toWireMessage(row));
      socket.emit('chat:history', { groupId, messages });
    } catch (err) {
      // History is best-effort — a load failure must not drop the connection.
      console.error('group:join history load failed', err);
    }
  });

  socket.on('group:leave', ({ groupId }) => {
    if (groupId == null) return;
    verifiedGroups.delete(groupId);
    socket.leave(room(groupId));
  });

  // A member sent a message. Persist it, then broadcast the stored row to the
  // WHOLE room including the sender, so every client renders from the same
  // canonical event (single source of truth — no dupes, no optimistic drift).
  socket.on('chat:message', async ({ groupId, text }) => {
    if (groupId == null) return;
    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (!trimmed) return;

    try {
      if (!(await isGroupMember(groupId, userId))) return;
      const row = await prisma.groupMessage.create({
        data: { group_id: groupId, user_id: userId, content: trimmed },
        include: { user: { select: { display_name: true, username: true } } },
      });
      const wire = toWireMessage(row, socket.data.name);
      io.to(room(groupId)).emit('chat:message', wire);

      // Update EVERY member's sidebar preview live — including members not currently
      // viewing this group, who aren't in its room and so never see the chat:message
      // above. Emit a lightweight preview to each member's per-user room (joined on
      // connect in sockets/index.js). Best-effort — a failure must not break send.
      try {
        const members = await prisma.groupMember.findMany({
          where: { group_id: groupId },
          select: { user_id: true },
        });
        const preview = {
          groupId,
          last_message: { text: wire.text, name: wire.name, user_id: wire.userId, at: wire.at },
        };
        for (const { user_id } of members) {
          io.to(`user:${user_id}`).emit('group:preview', preview);
        }
      } catch (previewErr) {
        console.error('group:preview broadcast failed', previewErr);
      }
    } catch (err) {
      console.error('chat:message persist failed', err);
    }
  });

  // A member started a session. Broadcast to the whole room (incl. sender) so
  // every client shows the session card live, inline in their own chat.
  // Ephemeral — reconstructed from live session state, not replayed from history.
  //
  // The host creates the Session over REST first, then emits this with the new
  // `sessionId`; we relay it so every OTHER member's client can adopt the same
  // session (load its roster, drive analyze/ready) and share one synchronized
  // countdown anchored to `at`. `sessionId` may be absent for a legacy/no-op
  // start — clients then fall back to their own session state.
  socket.on('session:start', async ({ groupId, sessionId }) => {
    if (!Number.isInteger(groupId)) return;
    // DB-checked rather than cached: this drives every other client to ADOPT a
    // session id, so an unverified sender could plant a bogus session card in a
    // group's chat. Once per session, so the round-trip is worth the certainty.
    if (!(await isGroupMember(groupId, userId))) return;
    io.to(room(groupId)).emit('session:start', {
      groupId,
      sessionId: sessionId ?? null,
      startedBy: socket.data.userId ?? null,
      at: new Date().toISOString(),
    });
  });

  // Typing presence — ephemeral, never stored. Relay to OTHERS in the room
  // (socket.to excludes the sender) so you never see your own "typing…".
  // Gated on the verified set, not the DB: this fires on every keystroke burst, and
  // a socket can only be in the set by having passed the check in group:join.
  const emitTyping = (groupId, isTyping) => {
    if (!verifiedGroups.has(groupId)) return;
    socket.to(room(groupId)).emit('typing:update', {
      groupId,
      userId: socket.data.userId ?? null,
      name: socket.data.name ?? null,
      isTyping,
    });
  };
  socket.on('typing:start', ({ groupId }) => emitTyping(groupId, true));
  socket.on('typing:stop', ({ groupId }) => emitTyping(groupId, false));

  // A member voted for a restaurant on the results page. Ephemeral — never persisted;
  // it exists only to show the group's live consensus before the host confirms a pick.
  // Relay to EVERY group member's per-user room (not the group room): a member on the
  // results page has left the group room (useSocket's unmount emits group:leave), so a
  // group-room emit wouldn't reach them — the per-user room does (same reason
  // group:preview / session:picks fan out per-user). The echo also reaches the sender,
  // so their own client applies the vote from the single source of truth (no local
  // double-toggle). voterId comes from the authenticated socket, never the client.
  socket.on('vote:cast', async ({ groupId, restaurantId }) => {
    const gid = Number(groupId);
    const rid = Number(restaurantId);
    if (!Number.isInteger(gid) || !Number.isInteger(rid)) return;
    try {
      if (!(await isGroupMember(gid, userId))) return;
      const payload = { groupId: gid, restaurantId: rid, userId };
      const members = await prisma.groupMember.findMany({
        where: { group_id: gid },
        select: { user_id: true },
      });
      for (const { user_id } of members) {
        io.to(`user:${user_id}`).emit('vote:update', payload);
      }
    } catch (err) {
      console.error('vote:cast relay failed', err);
    }
  });
};

export { registerSessionHandlers };
