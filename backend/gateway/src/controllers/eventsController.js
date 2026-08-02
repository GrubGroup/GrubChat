// Event request handlers: the caller's dining history.
import { prisma } from '../lib/prisma.js';

/**
 * GET /api/events — past outings the caller attended (Event.attendees M:N).
 * Newest-first; returns the flat event shape used across the app.
 */
const listEvents = async (req, res, next) => {
  try {
    const events = await prisma.event.findMany({
      where: { attendees: { some: { id: req.user.id } } },
      orderBy: { date: 'desc' },
      select: {
        id: true,
        date: true,
        address: true,
        lat: true,
        lon: true,
        restaurant_id: true,
        restaurant_name: true,
        occasion: true,
        time_slot: true,
        group_id: true,
        group_name: true,
        // Who attended — snapshotted from the session members at close time
        // (closeSession connects them). Surfaced so the Events detail can show a
        // "Who's going" list with real names + avatars (avatar_url so the Avatar
        // matches the profile image shown in chat/roster, not a default). Absent
        // deactivated_at lets the UI grey out + X an attendee who has since deleted
        // their account (upcoming events only).
        attendees: {
          select: {
            id: true,
            username: true,
            display_name: true,
            avatar_url: true,
            deactivated_at: true,
          },
        },
        // The booked restaurant's cuisines. The Event row snapshots only the
        // NAME, but the Events UI illustrates each outing with a cuisine photo
        // (frontend/src/constants/cuisineImages.ts), so it needs the tags. Read
        // through the relation rather than making the client load the whole
        // ~2k-row catalog just to look up a handful of ids.
        restaurant: { select: { cuisine_tags: true } },
      },
    });
    // Flatten the relation and map deactivated_at to a clean boolean so the wire
    // shape doesn't leak the timestamp or a nested object; the frontend only
    // needs to know whether to grey+X the name, and which photos to draw from.
    const shaped = events.map(({ restaurant, ...e }) => ({
      ...e,
      cuisine_tags: restaurant?.cuisine_tags ?? [],
      attendees: e.attendees.map(({ deactivated_at, ...a }) => ({
        ...a,
        deactivated: Boolean(deactivated_at),
      })),
    }));
    return res.status(200).json(shaped);
  } catch (err) {
    return next(err);
  }
};

export { listEvents };
