// User lookup handlers. Currently just username search, used by the group
// creation member-picker. Caller-scoped: assumes requireAuth ran.
import { prisma } from '../lib/prisma.js';

// Don't search on 1-char fragments — too broad, and would dump most of the table.
const MIN_QUERY_LENGTH = 2;
const MAX_RESULTS = 10;

/**
 * GET /api/users/search?q=<text> — find users by username (case-insensitive
 * substring), excluding the caller. Returns up to MAX_RESULTS lightweight rows
 * for the member-picker. A too-short/blank query returns an empty array.
 */
const searchUsers = async (req, res, next) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (q.length < MIN_QUERY_LENGTH) {
    return res.status(200).json([]);
  }

  try {
    const users = await prisma.user.findMany({
      where: {
        username: { contains: q, mode: 'insensitive' },
        id: { not: req.user.id },
        // Exclude soft-deleted accounts so a scrubbed `deleted_*` handle can't
        // surface in the member-picker.
        deactivated_at: null,
      },
      select: { id: true, username: true, display_name: true, avatar_url: true },
      orderBy: { username: 'asc' },
      take: MAX_RESULTS,
    });
    return res.status(200).json(users);
  } catch (err) {
    return next(err);
  }
};

export { searchUsers };
