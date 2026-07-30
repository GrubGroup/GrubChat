// Group request handlers: groups, membership, chat history, and group-scoped
// sessions/events. All handlers are caller-scoped and assume requireAuth ran.
import { prisma } from '../lib/prisma.js';

// Valid GroupMessage.message_type values (mirrors the Prisma MessageType enum).
const MESSAGE_TYPES = ['TEXT', 'IMG', 'SYSTEM', 'SESSION_BLOCK'];

const DEFAULT_MESSAGE_LIMIT = 50;
const MAX_MESSAGE_LIMIT = 100;

/** Parse a route/query param to a positive integer, or null when invalid. */
const toPositiveInt = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * Notify a set of users that their group membership changed, so their client can
 * live-refresh the sidebar without a manual reload. Emits to per-user rooms
 * (`user:{id}`, joined on connect in sockets/index.js) — NOT the group room, since
 * a newly-added member hasn't joined that yet. The payload carries only `groupId`;
 * the client re-fetches the full list (reusing listGroups' shaping). Best-effort:
 * a socket/emit failure must never block the REST response.
 */
const notifyMembership = (req, event, userIds, groupId) => {
  try {
    const io = req.app.get('io');
    if (!io) return;
    for (const userId of userIds) {
      io.to(`user:${userId}`).emit(event, { groupId });
    }
  } catch (err) {
    console.error(`${event} notify failed`, err);
  }
};

/**
 * Resolve membership: returns true when `userId` belongs to `groupId`.
 * Used to guard every group-scoped read/write with a 403.
 */
const isGroupMember = async (groupId, userId) => {
  const membership = await prisma.groupMember.findUnique({
    where: { group_id_user_id: { group_id: groupId, user_id: userId } },
  });
  return Boolean(membership);
};

/**
 * GET /api/groups — list groups the caller belongs to, with a member count.
 */
const listGroups = async (req, res, next) => {
  try {
    const groups = await prisma.group.findMany({
      where: { members: { some: { user_id: req.user.id } } },
      include: {
        _count: { select: { members: true } },
        // The single most recent non-system message, for the sidebar preview
        // line (SYSTEM lines like "X has left the group" are not previews).
        messages: {
          where: { message_type: { not: 'SYSTEM' } },
          orderBy: { id: 'desc' },
          take: 1,
          include: { user: { select: { display_name: true, username: true } } },
        },
      },
      orderBy: { created_at: 'desc' },
    });
    const shaped = groups.map(({ _count, messages, ...group }) => {
      const last = messages[0];
      return {
        ...group,
        member_count: _count.members,
        last_message: last
          ? {
              text: last.content,
              name: last.user?.display_name ?? last.user?.username ?? null,
              user_id: last.user_id,
              at: last.created_at.toISOString(),
            }
          : null,
      };
    });
    return res.status(200).json(shaped);
  } catch (err) {
    return next(err);
  }
};

/**
 * POST /api/groups — create a group; the caller is added as the first member.
 * Optional member_ids seeds additional members at creation.
 */
const createGroup = async (req, res, next) => {
  const { name, member_ids } = req.body ?? {};

  if (typeof name !== 'string' || name.trim() === '') {
    return res.status(400).json({ error: 'name is required.' });
  }
  if (member_ids !== undefined) {
    if (!Array.isArray(member_ids) || member_ids.some((id) => !Number.isInteger(id))) {
      return res.status(400).json({ error: 'member_ids must be an array of integers.' });
    }
  }

  // De-duplicate and always include the caller as a member.
  const memberIds = [...new Set([req.user.id, ...(member_ids ?? [])])];

  try {
    const group = await prisma.group.create({
      data: {
        name: name.trim(),
        members: {
          create: memberIds.map((user_id) => ({ user_id })),
        },
      },
      include: { members: { select: { user_id: true, joined_at: true } } },
    });
    // Tell every seeded member (including the caller) to refresh their sidebar so
    // the new group appears live without a reload.
    notifyMembership(req, 'group:added', memberIds, group.id);
    return res.status(201).json(group);
  } catch (err) {
    return next(err);
  }
};

/**
 * GET /api/groups/:group_id — group detail with members (joined to User).
 * 403 for non-members, 404 when the group does not exist.
 */
const getGroup = async (req, res, next) => {
  const groupId = toPositiveInt(req.params.group_id);
  if (!groupId) {
    return res.status(400).json({ error: 'group_id must be a positive integer.' });
  }

  try {
    const group = await prisma.group.findUnique({
      where: { id: groupId },
      include: {
        members: {
          select: {
            user_id: true,
            joined_at: true,
            user: { select: { display_name: true, avatar_url: true } },
          },
        },
      },
    });
    if (!group) {
      return res.status(404).json({ error: 'Group not found.' });
    }
    if (!group.members.some((m) => m.user_id === req.user.id)) {
      return res.status(403).json({ error: 'Not a group member.' });
    }

    const members = group.members.map(({ user, user_id, joined_at }) => ({
      user_id,
      display_name: user?.display_name ?? null,
      avatar_url: user?.avatar_url ?? null,
      joined_at,
    }));
    return res.status(200).json({ ...group, members });
  } catch (err) {
    return next(err);
  }
};

/**
 * POST /api/groups/:group_id/members — add a member by user_id or username.
 * 403 non-member caller, 404 missing group/user, 409 already a member.
 */
const addMember = async (req, res, next) => {
  const groupId = toPositiveInt(req.params.group_id);
  if (!groupId) {
    return res.status(400).json({ error: 'group_id must be a positive integer.' });
  }

  const { user_id, username } = req.body ?? {};
  if (user_id === undefined && username === undefined) {
    return res.status(400).json({ error: 'Provide either user_id or username.' });
  }
  if (user_id !== undefined && !Number.isInteger(user_id)) {
    return res.status(400).json({ error: 'user_id must be an integer.' });
  }

  try {
    const group = await prisma.group.findUnique({ where: { id: groupId } });
    if (!group) {
      return res.status(404).json({ error: 'Group not found.' });
    }
    if (!(await isGroupMember(groupId, req.user.id))) {
      return res.status(403).json({ error: 'Not a group member.' });
    }

    // Resolve the target user from either id or username.
    const target = user_id !== undefined
      ? await prisma.user.findUnique({ where: { id: user_id } })
      : await prisma.user.findUnique({ where: { username } });
    // A soft-deleted account must not be re-addable to a group.
    if (!target || target.deactivated_at) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const existing = await prisma.groupMember.findUnique({
      where: { group_id_user_id: { group_id: groupId, user_id: target.id } },
    });
    if (existing) {
      return res.status(409).json({ error: 'User is already a group member.' });
    }

    const member = await prisma.groupMember.create({
      data: { group_id: groupId, user_id: target.id },
    });

    // Announce the arrival to the room: persist a SYSTEM message and broadcast it
    // over the existing chat pipeline so live clients append it and reloads
    // replay it in history. Best-effort — never block the add.
    try {
      const name = target.display_name ?? target.username ?? 'Someone';
      const row = await prisma.groupMessage.create({
        data: {
          group_id: groupId,
          user_id: target.id,
          content: `${name} has entered the group`,
          message_type: 'SYSTEM',
        },
      });
      const io = req.app.get('io');
      io?.to(`group:${groupId}`).emit('chat:message', {
        id: String(row.id),
        groupId,
        userId: target.id,
        name,
        text: row.content,
        at: row.created_at.toISOString(),
        type: 'system',
      });
    } catch (broadcastErr) {
      console.error('add-member system message failed', broadcastErr);
    }

    // Tell the added user to refresh their sidebar so the group appears live. Sent
    // to their per-user room — they haven't joined the group's room yet, so the
    // system chat:message above never reaches them.
    notifyMembership(req, 'group:added', [target.id], groupId);

    return res.status(201).json(member);
  } catch (err) {
    return next(err);
  }
};

/**
 * DELETE /api/groups/:group_id/members/:user_id — remove a member.
 * Callers may remove themselves (leave); otherwise membership is required.
 * 403 non-member caller, 404 when the target is not a member. Returns 204.
 */
const removeMember = async (req, res, next) => {
  const groupId = toPositiveInt(req.params.group_id);
  const targetId = toPositiveInt(req.params.user_id);
  if (!groupId || !targetId) {
    return res
      .status(400)
      .json({ error: 'group_id and user_id must be positive integers.' });
  }

  try {
    if (!(await isGroupMember(groupId, req.user.id))) {
      return res.status(403).json({ error: 'Not a group member.' });
    }

    // Include the user so we can name them in the "X has left the group" line.
    const target = await prisma.groupMember.findUnique({
      where: { group_id_user_id: { group_id: groupId, user_id: targetId } },
      include: { user: { select: { display_name: true, username: true } } },
    });
    if (!target) {
      return res.status(404).json({ error: 'Member not found.' });
    }

    await prisma.groupMember.delete({
      where: { group_id_user_id: { group_id: groupId, user_id: targetId } },
    });

    // Announce the departure to the remaining members: persist a SYSTEM message
    // and broadcast it over the existing chat pipeline so live clients append it
    // and reloads replay it in history. Best-effort — never block the leave.
    try {
      const name = target.user?.display_name ?? target.user?.username ?? 'Someone';
      const row = await prisma.groupMessage.create({
        data: {
          group_id: groupId,
          user_id: targetId,
          content: `${name} has left the group`,
          message_type: 'SYSTEM',
        },
      });
      const io = req.app.get('io');
      io?.to(`group:${groupId}`).emit('chat:message', {
        id: String(row.id),
        groupId,
        userId: targetId,
        name,
        text: row.content,
        at: row.created_at.toISOString(),
        type: 'system',
      });
    } catch (broadcastErr) {
      console.error('leave-group system message failed', broadcastErr);
    }

    // Tell the removed user to refresh their sidebar so the group drops off live.
    notifyMembership(req, 'group:removed', [targetId], groupId);

    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
};

/**
 * GET /api/groups/:group_id/messages?limit=&before= — paginated chat history,
 * newest-first. `before` is a message id cursor (returns messages older than it).
 * 403 for non-members.
 */
const listMessages = async (req, res, next) => {
  const groupId = toPositiveInt(req.params.group_id);
  if (!groupId) {
    return res.status(400).json({ error: 'group_id must be a positive integer.' });
  }

  const { limit, before } = req.query;
  let take = DEFAULT_MESSAGE_LIMIT;
  if (limit !== undefined) {
    const parsed = Number(limit);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return res.status(400).json({ error: 'limit must be a positive integer.' });
    }
    take = Math.min(parsed, MAX_MESSAGE_LIMIT);
  }
  let beforeId;
  if (before !== undefined) {
    beforeId = Number(before);
    if (!Number.isInteger(beforeId) || beforeId <= 0) {
      return res.status(400).json({ error: 'before must be a positive integer id.' });
    }
  }

  try {
    if (!(await isGroupMember(groupId, req.user.id))) {
      return res.status(403).json({ error: 'Not a group member.' });
    }

    const messages = await prisma.groupMessage.findMany({
      where: {
        group_id: groupId,
        ...(beforeId ? { id: { lt: beforeId } } : {}),
      },
      orderBy: { id: 'desc' },
      take,
    });
    return res.status(200).json(messages);
  } catch (err) {
    return next(err);
  }
};

/**
 * POST /api/groups/:group_id/messages — persist a chat message.
 * 400 empty content / invalid message_type, 403 for non-members.
 */
const postMessage = async (req, res, next) => {
  const groupId = toPositiveInt(req.params.group_id);
  if (!groupId) {
    return res.status(400).json({ error: 'group_id must be a positive integer.' });
  }

  const { content, message_type } = req.body ?? {};
  if (typeof content !== 'string' || content.trim() === '') {
    return res.status(400).json({ error: 'content is required.' });
  }
  const type = message_type ?? 'TEXT';
  if (!MESSAGE_TYPES.includes(type)) {
    return res
      .status(400)
      .json({ error: `message_type must be one of: ${MESSAGE_TYPES.join(', ')}.` });
  }

  try {
    if (!(await isGroupMember(groupId, req.user.id))) {
      return res.status(403).json({ error: 'Not a group member.' });
    }

    const message = await prisma.groupMessage.create({
      data: {
        group_id: groupId,
        user_id: req.user.id,
        content,
        message_type: type,
      },
    });
    return res.status(201).json(message);
  } catch (err) {
    return next(err);
  }
};

/**
 * GET /api/groups/:group_id/sessions — sessions started from this group.
 * 403 for non-members.
 */
const listGroupSessions = async (req, res, next) => {
  const groupId = toPositiveInt(req.params.group_id);
  if (!groupId) {
    return res.status(400).json({ error: 'group_id must be a positive integer.' });
  }

  try {
    if (!(await isGroupMember(groupId, req.user.id))) {
      return res.status(403).json({ error: 'Not a group member.' });
    }

    const sessions = await prisma.session.findMany({
      where: { group_id: groupId },
      orderBy: { created_at: 'desc' },
    });
    return res.status(200).json(sessions);
  } catch (err) {
    return next(err);
  }
};

/**
 * GET /api/groups/:group_id/sessions/current — the group's current OPEN session,
 * or null. Lets a client rebind an in-progress session on page reload (the socket
 * `session:start` was already missed and isn't replayed). "Open" = not host-closed:
 * `closed_at` is set ONLY by the host's explicit restaurant confirm (closeSession);
 * a session that finishes by timeout or auto-complete keeps `closed_at = null`, so
 * newest `closed_at: null` is the right "current" signal. Returns 200 with the
 * session or null (not 404) so "no active session" is a normal state. 403 for
 * non-members.
 */
const getCurrentGroupSession = async (req, res, next) => {
  const groupId = toPositiveInt(req.params.group_id);
  if (!groupId) {
    return res.status(400).json({ error: 'group_id must be a positive integer.' });
  }

  try {
    if (!(await isGroupMember(groupId, req.user.id))) {
      return res.status(403).json({ error: 'Not a group member.' });
    }

    const session = await prisma.session.findFirst({
      where: { group_id: groupId, closed_at: null },
      orderBy: { created_at: 'desc' },
    });
    return res.status(200).json(session ?? null);
  } catch (err) {
    return next(err);
  }
};

/**
 * GET /api/groups/:group_id/events — finalized outings for this group.
 * 403 for non-members.
 */
const listGroupEvents = async (req, res, next) => {
  const groupId = toPositiveInt(req.params.group_id);
  if (!groupId) {
    return res.status(400).json({ error: 'group_id must be a positive integer.' });
  }

  try {
    if (!(await isGroupMember(groupId, req.user.id))) {
      return res.status(403).json({ error: 'Not a group member.' });
    }

    const events = await prisma.event.findMany({
      where: { group_id: groupId },
      orderBy: { date: 'desc' },
    });
    return res.status(200).json(events);
  } catch (err) {
    return next(err);
  }
};

export {
  listGroups,
  createGroup,
  getGroup,
  addMember,
  removeMember,
  listMessages,
  postMessage,
  listGroupSessions,
  getCurrentGroupSession,
  listGroupEvents,
};
