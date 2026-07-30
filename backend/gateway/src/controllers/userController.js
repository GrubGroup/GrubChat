// User request handlers: read and update the caller's own account identity
// (display_name, username). Auth credentials (email/password) are owned by
// Better Auth and are NOT edited here.
import { prisma } from '../lib/prisma.js';

// Better Auth's username plugin permits letters, numbers, dot, underscore.
// Mirror that here so gateway edits can't create usernames sign-in would reject.
const USERNAME_RE = /^[a-zA-Z0-9._]{3,30}$/;

/**
 * GET /api/user/me — return the caller's own User record (identity fields the
 * profile header shows: username, email, display_name, avatar_url, role).
 */
const getMe = async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        username: true,
        email: true,
        display_name: true,
        avatar_url: true,
        role: true,
        created_at: true,
        updated_at: true,
      },
    });
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }
    return res.status(200).json(user);
  } catch (err) {
    return next(err);
  }
};

/**
 * PATCH /api/user — update the caller's display_name and/or username.
 * Enforces username uniqueness with a pre-check (returns 409) and falls back to
 * catching a P2002 unique-constraint violation in case of a race.
 */
const updateMe = async (req, res, next) => {
  const body = req.body ?? {};
  const data = {};

  if (body.display_name !== undefined) {
    if (body.display_name !== null && typeof body.display_name !== 'string') {
      return res.status(400).json({ error: 'display_name must be a string.' });
    }
    data.display_name = body.display_name;
  }

  if (body.username !== undefined) {
    if (typeof body.username !== 'string' || !USERNAME_RE.test(body.username)) {
      return res.status(400).json({
        error: 'Username must be 3–30 characters: letters, numbers, dots, underscores.',
      });
    }
    data.username = body.username;
  }

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ error: 'Nothing to update.' });
  }

  try {
    // Pre-check uniqueness: a taken username belonging to a different user is a
    // conflict. (Matches the pre-check pattern used elsewhere in the gateway.)
    if (data.username) {
      const owner = await prisma.user.findUnique({
        where: { username: data.username },
      });
      if (owner && owner.id !== req.user.id) {
        return res.status(409).json({ error: 'Username already taken.' });
      }
    }

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data,
      select: {
        id: true,
        username: true,
        email: true,
        display_name: true,
        avatar_url: true,
        role: true,
        created_at: true,
        updated_at: true,
      },
    });
    return res.status(200).json(user);
  } catch (err) {
    // Race fallback: unique-constraint violation slipped past the pre-check.
    if (err?.code === 'P2002') {
      return res.status(409).json({ error: 'Username already taken.' });
    }
    return next(err);
  }
};

/**
 * DELETE /api/user — "delete" the caller's own account. This is a soft delete:
 * the User row is KEPT (so past group messages and event attendance stay
 * attributed), but the account is made unusable and its identity is freed:
 *   - deactivated_at is stamped (NULL = active elsewhere in the app);
 *   - email/username/displayUsername are scrubbed to reserved throwaway values,
 *     which frees the old email + username so a brand-new signup can reuse them;
 *   - all Account rows are deleted (drops the password credential AND disconnects
 *     Google OAuth, so neither login path works);
 *   - all AuthSession rows are deleted (revokes every live session);
 *   - all GroupMember rows are deleted (the user leaves every group chat).
 * SessionMember / Event attendance / GroupMessage rows are intentionally KEPT.
 *
 * Open sessions the caller HOSTS are never left host-less: each is handed off to
 * its earliest-joined remaining member, or auto-closed when the caller is the
 * only member (a solo/abandoned session). So deletion always succeeds — the old
 * "close your session first" 409 block is gone.
 * Login then fails cleanly as if the account never existed: the mangled email +
 * deleted accounts make getSession null and /api/auth-methods report exists:false.
 */
const deactivateMe = async (req, res, next) => {
  const id = req.user.id;

  try {
    // Every open (not-yet-closed) session this user hosts, with the OTHER members
    // ordered by join time so we can promote the earliest-joined one. closeSession
    // is the only thing that sets closed_at, so closed_at: null == still open.
    const openHosted = await prisma.session.findMany({
      where: { host_user_id: id, closed_at: null },
      select: {
        id: true,
        group_id: true,
        members: {
          where: { user_id: { not: id } },
          orderBy: { joined_at: 'asc' },
          select: {
            user_id: true,
            user: { select: { display_name: true, username: true } },
          },
        },
      },
    });

    // Decide each hosted session's fate: hand off to the earliest-joined remaining
    // member, or auto-close it when the host is the only one left. Build the tx ops
    // now; collect hand-offs so we can announce them (socket + system chat) after
    // the commit succeeds.
    const sessionOps = [];
    const handoffs = []; // { sessionId, groupId, newHostId, newHostName }
    const closedAt = new Date();
    for (const s of openHosted) {
      const successor = s.members[0];
      if (successor) {
        sessionOps.push(
          prisma.session.update({
            where: { id: s.id },
            data: { host_user_id: successor.user_id },
          }),
        );
        handoffs.push({
          sessionId: s.id,
          groupId: s.group_id,
          newHostId: successor.user_id,
          newHostName:
            successor.user?.display_name ?? successor.user?.username ?? 'A member',
        });
      } else {
        // No other member — auto-close the abandoned session (same terminal state
        // closeSession produces; no Event is created since nothing was confirmed).
        sessionOps.push(
          prisma.session.update({
            where: { id: s.id },
            data: { closed_at: closedAt },
          }),
        );
      }
    }

    // Atomic: a partial scrub that freed the email but left sessions alive would
    // be a security hole, so host hand-off + identity-scrub + auth-revoke +
    // group-leave commit together or not at all.
    await prisma.$transaction([
      // Hand off / auto-close hosted sessions FIRST so no open session is ever
      // left pointing at a scrubbed host row.
      ...sessionOps,
      prisma.user.update({
        where: { id },
        data: {
          deactivated_at: closedAt,
          // Reserved, collision-free throwaway values (the id is unique+immutable).
          // `.invalid` is RFC-2606 reserved and can never be a real address, so the
          // original email/username are freed for a future signup to reuse.
          email: `deleted+${id}@deleted.invalid`,
          username: `deleted_${id}`,
          displayUsername: null,
          // display_name is intentionally preserved so old messages/events stay
          // attributed to the person's name.
        },
      }),
      // Drop credential (password) + google (OAuth) — breaks every login path.
      prisma.account.deleteMany({ where: { userId: id } }),
      // Revoke all live sessions so any lingering cookie resolves to null.
      prisma.authSession.deleteMany({ where: { userId: id } }),
      // Leave every group chat (removed from rosters); prior messages remain.
      prisma.groupMember.deleteMany({ where: { user_id: id } }),
      // Leave every OPEN session too, so a member who can never finish doesn't
      // stall auto-complete (doneCount === total). Membership in CLOSED sessions
      // is kept for event/history attribution.
      prisma.sessionMember.deleteMany({
        where: { user_id: id, session: { closed_at: null } },
      }),
    ]);

    // Announce each hand-off (best-effort — never fail the delete on a socket/DB
    // hiccup). Mirrors closeSession: a persisted SYSTEM chat line so reloads replay
    // it, plus a session:host_changed event so a live client re-reads who can close.
    const io = req.app.get('io');
    for (const h of handoffs) {
      if (h.groupId == null) continue;
      try {
        const row = await prisma.groupMessage.create({
          data: {
            group_id: h.groupId,
            user_id: h.newHostId,
            content: `${h.newHostName} is now the session host`,
            message_type: 'SYSTEM',
          },
        });
        io?.to(`group:${h.groupId}`).emit('chat:message', {
          id: String(row.id),
          groupId: h.groupId,
          userId: h.newHostId,
          name: h.newHostName,
          text: row.content,
          at: row.created_at.toISOString(),
          type: 'system',
        });
        io?.to(`group:${h.groupId}`).emit('session:host_changed', {
          groupId: h.groupId,
          sessionId: h.sessionId,
          newHostId: h.newHostId,
          at: closedAt.toISOString(),
        });
      } catch (announceErr) {
        console.error('host hand-off announce failed', announceErr);
      }
    }

    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
};

export { getMe, updateMe, deactivateMe };
