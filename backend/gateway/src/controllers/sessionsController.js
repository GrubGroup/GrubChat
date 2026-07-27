// Session/event request handlers.
import { prisma } from '../lib/prisma.js';
import {
  getRecommendations as fetchRecommendations,
  analyzeTurn as analyzeTurnAi,
} from '../services/aiClient.js';
import { geocode } from '../services/geocodeClient.js';

/** Parse a route param to a positive integer, or null when invalid. */
const toPositiveInt = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** Broadcast a payload to a group's Socket.IO room (best-effort, never throws). */
const broadcastToGroup = (req, groupId, event, payload) => {
  if (groupId == null) return;
  try {
    const io = req.app.get('io');
    io?.to(`group:${groupId}`).emit(event, payload);
  } catch (err) {
    console.error(`socket broadcast ${event} failed`, err);
  }
};

/**
 * Broadcast a ready recommendation to the session's group room. Recommendations
 * are delivered into the SESSION / RESULTS flow only — never as a group-chat
 * message — so this carries just the ids + ranked items (no messageId, no
 * persisted GroupMessage). Shared by the manual generate path and the auto-
 * complete path so both emit an identical `session:picks` event.
 */
const broadcastPicks = async (io, groupId, sessionId, recommendation) => {
  if (groupId == null || !io) return;
  const payload = {
    groupId,
    sessionId,
    recommendationId: recommendation.id,
    items: recommendation.items ?? [],
  };
  try {
    io.to(`group:${groupId}`).emit('session:picks', payload);
    // Also deliver to each member's always-joined per-user room (user:{id}, joined
    // on connect in sockets/index.js). A member viewing the results page has left
    // the group room (useSocket's unmount emits group:leave), so the group-room
    // emit above never reaches them — the per-user room does. Duplicate delivery to
    // a member still in the group room is harmless: receivePicks is idempotent.
    const members = await prisma.sessionMember.findMany({
      where: { session_id: sessionId },
      select: { user_id: true },
    });
    for (const { user_id } of members) {
      io.to(`user:${user_id}`).emit('session:picks', payload);
    }
  } catch (err) {
    console.error('socket broadcast session:picks failed', err);
  }
};

// In-flight auto-complete guard: session ids currently generating results, so two
// members finishing near-simultaneously don't both kick off the pipeline in this
// process. Paired with a DB check (a prior Recommendation row) below; a
// multi-instance deploy would want an advisory lock, but this closes the common
// single-process race and never blocks the status write.
const autoCompleting = new Set();

/**
 * Auto-complete a session the moment EVERY member has finished: generate the
 * group recommendation and broadcast it — no host click, no timer wait. Fire-
 * and-forget (never awaited by the request) so the member's "I'm Finished" PATCH
 * returns immediately rather than blocking on the ≤120s pipeline. Best-effort:
 * any failure is logged and the timer fallback can still force picks later.
 *
 * Guarded three ways so it runs once: only when this turn is the LAST finish
 * (doneCount === total), an in-process lock, and a DB check for an existing
 * Recommendation row.
 */
const maybeAutoComplete = async (io, sessionId, groupId) => {
  if (autoCompleting.has(sessionId)) return;
  autoCompleting.add(sessionId);
  try {
    const existing = await prisma.recommendation.findFirst({
      where: { session_id: sessionId },
      select: { id: true },
    });
    if (existing) return; // already generated (timer/manual/another finisher)

    const recommendation = await fetchRecommendations(sessionId, { forcePartial: false });
    await broadcastPicks(io, groupId, sessionId, recommendation);
  } catch (err) {
    // 409 (not all confirmed — shouldn't happen here), 502 (upstream), etc. The
    // timer fallback / manual generate remain as recovery paths.
    console.error(`auto-complete generation failed for session ${sessionId}`, err);
  } finally {
    autoCompleting.delete(sessionId);
  }
};

/**
 * POST /api/sessions/:session_id/recommendations — proxy the group orchestrator.
 *
 * Delegates to the ai_service, which reconciles member preferences into a ranked
 * recommendation. On an ai_service error we pass its HTTP status through (e.g. 409
 * when not all members have confirmed, 502 on an upstream LLM/embedding failure)
 * rather than collapsing everything to a 500.
 *
 * Auth-guarded + member-scoped (see the route): only a session member may
 * trigger picks. On success we broadcast `session:picks` to the group room so
 * every client adopts the ranked items into the SESSION / RESULTS flow. The
 * recommendation is NOT written into the group chat — it stays durable in the
 * Recommendation table (fetchable via GET /:id/recommendations). The broadcast
 * is best-effort — a socket hiccup never fails the call.
 */
const getRecommendations = async (req, res, next) => {
  const sessionId = toPositiveInt(req.params.session_id);
  if (!sessionId) {
    return res.status(400).json({ error: 'session_id must be a positive integer.' });
  }

  const forcePartial = req.body?.force_partial === true;

  try {
    // Membership guard: reject a caller who isn't part of this session before we
    // proxy — mirrors submitQa/analyzeTurn.
    const member = await prisma.sessionMember.findUnique({
      where: { session_id_user_id: { session_id: sessionId, user_id: req.user.id } },
    });
    if (!member) {
      return res.status(403).json({ error: 'Not a session member.' });
    }

    // force_partial is the TIMEOUT / expiry path: the session's clock ran out, so
    // it completes now regardless of who finished. Force-finish every remaining
    // member and broadcast an all-done completion so every client's card flips to
    // complete (matching "on timeout, allDone should be true"), then generate over
    // whoever actually answered.
    if (forcePartial) {
      await prisma.sessionMember.updateMany({
        where: { session_id: sessionId, status: false },
        data: { status: true },
      });
      const session = await prisma.session.findUnique({
        where: { id: sessionId },
        select: {
          group_id: true,
          closed_at: true,
          members: { select: { user_id: true } },
        },
      });
      if (session?.group_id != null) {
        const total = session.members.length;
        broadcastToGroup(req, session.group_id, 'session:member_done', {
          groupId: session.group_id,
          sessionId,
          userId: req.user.id,
          status: true,
          doneCount: total,
          total,
          allDone: true,
          closedAt: session.closed_at ?? null,
          at: new Date().toISOString(),
        });
      }
    }

    const recommendation = await fetchRecommendations(sessionId, { forcePartial });

    // Announce the ready picks to the group room (best-effort) so every client's
    // session/results view can adopt them without polling.
    try {
      const session = await prisma.session.findUnique({
        where: { id: sessionId },
        select: { group_id: true },
      });
      await broadcastPicks(req.app.get('io'), session?.group_id, sessionId, recommendation);
    } catch (deliveryErr) {
      console.error('top-picks broadcast failed', deliveryErr);
    }

    return res.status(200).json(recommendation);
  } catch (err) {
    if (err.response) {
      return res.status(err.response.status).json(err.response.data);
    }
    return next(err);
  }
};

/**
 * POST /api/sessions — start a session, optionally from a group.
 * When group_id is given the caller must be a member (403/404). The caller is
 * the host and is seeded as a member; group sessions seed all group members.
 *
 * The host also answers the pre-session modal here: `occasion` (host-only event
 * label), `scheduled_for` (the chosen event time — an ISO string, or omitted /
 * "now" to stamp now()), `location_address` (the primary group location, which
 * we geocode to lat/lon), and `time_limit` (the answer window). occasion +
 * geocoded location are written to the HOST's Qa row so the orchestrator reads
 * them as the primary anchor; scheduled_for is stored on the Session and drives
 * the open/closed hard filter. On session:start the client emits the socket
 * event with the new session id.
 */
const createSession = async (req, res, next) => {
  const {
    group_id,
    time_limit,
    occasion,
    scheduled_for,
    location_address,
    location_lat,
    location_lon,
  } = req.body ?? {};

  if (!Number.isInteger(time_limit) || time_limit <= 0) {
    return res.status(400).json({ error: 'time_limit must be a positive integer.' });
  }
  if (group_id !== undefined && group_id !== null && !Number.isInteger(group_id)) {
    return res.status(400).json({ error: 'group_id must be an integer.' });
  }
  if (occasion !== undefined && occasion !== null && typeof occasion !== 'string') {
    return res.status(400).json({ error: 'occasion must be a string.' });
  }
  if (
    location_address !== undefined &&
    location_address !== null &&
    typeof location_address !== 'string'
  ) {
    return res.status(400).json({ error: 'location_address must be a string.' });
  }
  const clientLatValid =
    location_lat === undefined || location_lat === null || typeof location_lat === 'number';
  const clientLonValid =
    location_lon === undefined || location_lon === null || typeof location_lon === 'number';
  if (!clientLatValid || !clientLonValid) {
    return res.status(400).json({ error: 'location_lat/location_lon must be numbers.' });
  }
  // scheduled_for: accept an ISO date string (custom time) or omit / "now"
  // (the host chose "Now") -> stamp the current time.
  let scheduledFor = new Date();
  if (
    scheduled_for !== undefined &&
    scheduled_for !== null &&
    scheduled_for !== 'now'
  ) {
    if (typeof scheduled_for !== 'string' || Number.isNaN(Date.parse(scheduled_for))) {
      return res.status(400).json({ error: 'scheduled_for must be an ISO date string or "now".' });
    }
    scheduledFor = new Date(scheduled_for);
  }

  try {
    // Seed members: always the host; for a group session, every group member.
    let memberIds = [req.user.id];

    if (group_id !== undefined && group_id !== null) {
      const group = await prisma.group.findUnique({
        where: { id: group_id },
        include: { members: { select: { user_id: true } } },
      });
      if (!group) {
        return res.status(404).json({ error: 'Group not found.' });
      }
      if (!group.members.some((m) => m.user_id === req.user.id)) {
        return res.status(403).json({ error: 'Not a group member.' });
      }
      memberIds = [...new Set([req.user.id, ...group.members.map((m) => m.user_id)])];
    }

    // Resolve the host's primary-anchor coords for the orchestrator. When the
    // client already sent coordinates (a picked Places suggestion), trust them
    // and skip the geocode — they match exactly what the host saw. Otherwise
    // geocode the typed address; a miss/outage degrades to null coords (address
    // text kept). Done BEFORE the transaction (external HTTP) so the tx stays
    // short and never holds a DB lock across the network round-trip.
    const hasAddress =
      typeof location_address === 'string' && location_address.trim();
    const hasClientCoords =
      typeof location_lat === 'number' && typeof location_lon === 'number';
    const coords = hasClientCoords
      ? { lat: location_lat, lon: location_lon }
      : hasAddress
        ? await geocode(location_address)
        : null;
    const seedHostQa = hasAddress || (typeof occasion === 'string' && occasion.trim());

    // Create the session (+ seeded members) and seed the HOST's Qa row with the
    // modal answers ATOMICALLY: occasion (host-only) + the geocoded primary
    // location. If the Qa seed fails, the session is rolled back rather than
    // orphaned. Members fill their own Qa rows via the sub-agent chat; the host's
    // row carries the event-level signals the pipeline reads as the primary anchor.
    const session = await prisma.$transaction(async (tx) => {
      const created = await tx.session.create({
        data: {
          host_user_id: req.user.id,
          group_id: group_id ?? null,
          time_limit,
          scheduled_for: scheduledFor,
          members: {
            create: memberIds.map((user_id) => ({ user_id })),
          },
        },
        include: { members: { select: { user_id: true, status: true } } },
      });

      if (seedHostQa) {
        const hostQaFields = {
          occasion: occasion ?? null,
          location_mode: hasAddress ? 'named' : null,
          location_address: location_address ?? null,
          location_lat: coords?.lat ?? null,
          location_lon: coords?.lon ?? null,
        };
        await tx.qa.upsert({
          where: {
            session_id_user_id: { session_id: created.id, user_id: req.user.id },
          },
          create: { session_id: created.id, user_id: req.user.id, ...hostQaFields },
          update: hostQaFields,
        });
      }

      return created;
    });

    return res.status(201).json(session);
  } catch (err) {
    return next(err);
  }
};

/**
 * GET /api/sessions/:session_id — session detail with members & readiness.
 * 403 for non-members, 404 when the session does not exist.
 */
const getSession = async (req, res, next) => {
  const sessionId = toPositiveInt(req.params.session_id);
  if (!sessionId) {
    return res.status(400).json({ error: 'session_id must be a positive integer.' });
  }

  try {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: {
        members: {
          select: {
            user_id: true,
            status: true,
            joined_at: true,
            user: { select: { display_name: true, username: true } },
          },
        },
      },
    });
    if (!session) {
      return res.status(404).json({ error: 'Session not found.' });
    }
    if (!session.members.some((m) => m.user_id === req.user.id)) {
      return res.status(403).json({ error: 'Not a session member.' });
    }

    const members = session.members.map(({ user, user_id, status, joined_at }) => ({
      user_id,
      display_name: user?.display_name ?? null,
      username: user?.username ?? null,
      status,
      joined_at,
    }));
    return res.status(200).json({ ...session, members });
  } catch (err) {
    return next(err);
  }
};

/**
 * POST /api/sessions/:session_id/members — join a session (status=false).
 * 400 when the session is closed, 404 missing, 409 already joined.
 */
const joinSession = async (req, res, next) => {
  const sessionId = toPositiveInt(req.params.session_id);
  if (!sessionId) {
    return res.status(400).json({ error: 'session_id must be a positive integer.' });
  }

  try {
    const session = await prisma.session.findUnique({ where: { id: sessionId } });
    if (!session) {
      return res.status(404).json({ error: 'Session not found.' });
    }
    if (session.closed_at) {
      return res.status(400).json({ error: 'Session is closed.' });
    }

    const existing = await prisma.sessionMember.findUnique({
      where: { session_id_user_id: { session_id: sessionId, user_id: req.user.id } },
    });
    if (existing) {
      return res.status(409).json({ error: 'Already joined this session.' });
    }

    const member = await prisma.sessionMember.create({
      data: { session_id: sessionId, user_id: req.user.id },
    });
    return res.status(201).json(member);
  } catch (err) {
    return next(err);
  }
};

/**
 * GET /api/sessions/:session_id/members — members & readiness (poll).
 * 403 for non-members.
 */
const listMembers = async (req, res, next) => {
  const sessionId = toPositiveInt(req.params.session_id);
  if (!sessionId) {
    return res.status(400).json({ error: 'session_id must be a positive integer.' });
  }

  try {
    const members = await prisma.sessionMember.findMany({
      where: { session_id: sessionId },
      select: {
        user_id: true,
        status: true,
        joined_at: true,
        user: { select: { display_name: true, username: true } },
      },
      orderBy: { joined_at: 'asc' },
    });
    if (!members.some((m) => m.user_id === req.user.id)) {
      return res.status(403).json({ error: 'Not a session member.' });
    }

    const shaped = members.map(({ user, user_id, status, joined_at }) => ({
      user_id,
      display_name: user?.display_name ?? null,
      username: user?.username ?? null,
      status,
      joined_at,
    }));
    return res.status(200).json(shaped);
  } catch (err) {
    return next(err);
  }
};

/**
 * PATCH /api/sessions/:session_id/members/me — set the caller's ready status.
 * 403/404 when the caller is not a member of the session.
 *
 * On success we broadcast `session:member_done` to the session's group room so
 * every client's live progress bar updates when a member finishes (the frontend
 * renders solely from this broadcast — no optimistic local flip). The payload
 * carries the fresh done/total counts so a late joiner or reload can reconcile.
 *
 * AUTO-COMPLETE: when this turn is the one that makes EVERY member done, we kick
 * off recommendation generation server-side (fire-and-forget, after responding)
 * so the group flips to results without waiting for the timer or a host click.
 */
const setReady = async (req, res, next) => {
  const sessionId = toPositiveInt(req.params.session_id);
  if (!sessionId) {
    return res.status(400).json({ error: 'session_id must be a positive integer.' });
  }

  const { status } = req.body ?? {};
  if (typeof status !== 'boolean') {
    return res.status(400).json({ error: 'status must be a boolean.' });
  }

  try {
    const existing = await prisma.sessionMember.findUnique({
      where: { session_id_user_id: { session_id: sessionId, user_id: req.user.id } },
    });
    if (!existing) {
      return res.status(404).json({ error: 'Not a session member.' });
    }

    const member = await prisma.sessionMember.update({
      where: { session_id_user_id: { session_id: sessionId, user_id: req.user.id } },
      data: { status },
    });

    // Broadcast live progress to the group room. Load the session (for group_id
    // + closed_at) and the fresh member counts in one go; best-effort so a socket
    // hiccup never fails the status write.
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: {
        group_id: true,
        closed_at: true,
        members: { select: { user_id: true, status: true } },
      },
    });

    const total = session?.members.length ?? 0;
    const doneCount = session?.members.filter((m) => m.status).length ?? 0;
    const allDone = total > 0 && doneCount === total;

    if (session?.group_id != null) {
      broadcastToGroup(req, session.group_id, 'session:member_done', {
        groupId: session.group_id,
        sessionId,
        userId: req.user.id,
        status,
        doneCount,
        total,
        // Let clients flip the card to a completed state without a separate fetch.
        allDone,
        closedAt: session.closed_at ?? null,
        at: new Date().toISOString(),
      });
    }

    // Respond BEFORE generating so the member's "I'm Finished" button never hangs
    // on the pipeline. Auto-complete only when THIS turn was the last finish
    // (existing status was false, now true, and everyone is done) and the session
    // isn't already closed.
    res.status(200).json(member);

    if (existing.status === false && status === true && allDone && !session?.closed_at) {
      void maybeAutoComplete(req.app.get('io'), sessionId, session?.group_id ?? null);
    }
    return;
  } catch (err) {
    return next(err);
  }
};

/**
 * POST /api/sessions/:session_id/qa — submit this member's session preferences.
 *
 * Qa is one row per (session, member): this UPSERTS the caller's own row (their
 * temporary, session-scoped overrides — cuisines/budget/location). occasion
 * describes the shared EVENT and is HOST-ONLY: a non-host's value is silently
 * dropped and the response flags `host_only_ignored` so the client can tell the
 * user only the host sets it. The event TIME is no longer a Qa field — it lives
 * on Session.scheduled_for, set in the pre-session modal. 400 on invalid ranges,
 * 403 for non-members.
 */
const submitQa = async (req, res, next) => {
  const sessionId = toPositiveInt(req.params.session_id);
  if (!sessionId) {
    return res.status(400).json({ error: 'session_id must be a positive integer.' });
  }

  const {
    preferred_cuisines,
    disliked_cuisines,
    occasion,
    location_mode,
    location_address,
    location_lat,
    location_lon,
    radius_miles,
    budget_min,
    budget_max,
  } = req.body ?? {};

  if (
    budget_min !== undefined &&
    budget_max !== undefined &&
    budget_min !== null &&
    budget_max !== null &&
    budget_min > budget_max
  ) {
    return res.status(400).json({ error: 'Inverted budget: budget_min must be <= budget_max.' });
  }
  if (radius_miles !== undefined && radius_miles !== null && radius_miles < 0) {
    return res.status(400).json({ error: 'radius_miles must be non-negative.' });
  }
  if (
    location_address !== undefined &&
    location_address !== null &&
    typeof location_address !== 'string'
  ) {
    return res.status(400).json({ error: 'location_address must be a string.' });
  }

  try {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { host_user_id: true },
    });
    if (!session) {
      return res.status(404).json({ error: 'Session not found.' });
    }

    const member = await prisma.sessionMember.findUnique({
      where: { session_id_user_id: { session_id: sessionId, user_id: req.user.id } },
    });
    if (!member) {
      return res.status(403).json({ error: 'Not a session member.' });
    }

    // occasion is the host's to set. For a non-host, drop it and flag it so the
    // client can explain why (silent drop, not a hard failure).
    const isHost = session.host_user_id === req.user.id;
    const hostOnlyIgnored =
      !isHost && occasion !== undefined && occasion !== null;
    const occasionValue = isHost ? (occasion ?? null) : null;

    // When a member supplies an address, geocode it server-side and let the
    // derived coordinates override any client-sent lat/lon (stored coords must
    // match the stored address; a geocode miss/outage yields null coords rather
    // than blocking the save). With no address (e.g. realtime device location),
    // the client-sent coordinates pass through unchanged.
    const hasAddress =
      typeof location_address === 'string' && location_address.trim();
    const coords = hasAddress ? await geocode(location_address) : null;
    const resolvedLat = hasAddress ? (coords?.lat ?? null) : (location_lat ?? null);
    const resolvedLon = hasAddress ? (coords?.lon ?? null) : (location_lon ?? null);

    // Shared fields for both create and update (per-member overrides).
    const fields = {
      preferred_cuisines: preferred_cuisines ?? [],
      disliked_cuisines: disliked_cuisines ?? [],
      occasion: occasionValue,
      location_mode: location_mode ?? null,
      location_address: location_address ?? null,
      location_lat: resolvedLat,
      location_lon: resolvedLon,
      radius_miles: radius_miles ?? null,
      budget_min: budget_min ?? null,
      budget_max: budget_max ?? null,
    };

    const qa = await prisma.qa.upsert({
      where: { session_id_user_id: { session_id: sessionId, user_id: req.user.id } },
      create: { session_id: sessionId, user_id: req.user.id, ...fields },
      update: fields,
    });
    return res.status(201).json({ ...qa, host_only_ignored: hostOnlyIgnored });
  } catch (err) {
    return next(err);
  }
};

/**
 * GET /api/sessions/:session_id/recommendations — fetch the latest stored
 * recommendation for the session (gateway-direct Prisma read). Member-scoped.
 * 403 for a non-member, 404 when the session has no results yet.
 */
const getLatestRecommendation = async (req, res, next) => {
  const sessionId = toPositiveInt(req.params.session_id);
  if (!sessionId) {
    return res.status(400).json({ error: 'session_id must be a positive integer.' });
  }

  try {
    // Membership guard: a recommendation carries the group's picks AND the LLM's
    // justifications, which describe their dietary needs and budget — private to
    // that session's members. Mirrors getRecommendations / submitQa / analyzeTurn.
    // Checked BEFORE the lookup so a non-member gets 403 whether or not results
    // exist — a 403-vs-404 split would otherwise leak which sessions have results.
    const member = await prisma.sessionMember.findUnique({
      where: { session_id_user_id: { session_id: sessionId, user_id: req.user.id } },
    });
    if (!member) {
      return res.status(403).json({ error: 'Not a session member.' });
    }

    const recommendation = await prisma.recommendation.findFirst({
      where: { session_id: sessionId },
      orderBy: { created_at: 'desc' },
      include: {
        items: {
          select: {
            restaurant_id: true,
            match_score: true,
            justification: true,
            restaurant: { select: { name: true } },
          },
        },
      },
    });
    if (!recommendation) {
      return res.status(404).json({ error: 'No recommendation found.' });
    }

    const items = recommendation.items.map(({ restaurant, ...item }) => ({
      ...item,
      name: restaurant?.name ?? null,
    }));
    return res.status(200).json({ ...recommendation, items });
  } catch (err) {
    return next(err);
  }
};

/**
 * Format a Date into a short human-readable time-slot label for Event.time_slot
 * (a display string, e.g. "Fri, Jul 18, 7:00 PM"). Falls back to the ISO string.
 */
const formatTimeSlot = (dt) => {
  try {
    return dt.toLocaleString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return dt.toISOString();
  }
};

/**
 * POST /api/sessions/:session_id/close — the HOST confirms the chosen restaurant,
 * closing the session and creating the durable Event. Host-only (403); 409 when
 * already closed; 400 on a bad restaurant_id.
 *
 * The Event's date/time/location are sourced from what the host set up front:
 * Event.date + Event.time_slot come from Session.scheduled_for, and Event.lat/lon
 * + address are snapshotted from the host's Qa row (the geocoded primary
 * location). `date` / `address` may still be supplied in the body to override,
 * but default to the session's own data so the frontend confirm only needs to
 * send { restaurant_id }. Snapshots occasion (host-only) and attaches all session
 * members as attendees, then deletes the transient Qa rows — all atomically.
 */
const closeSession = async (req, res, next) => {
  const sessionId = toPositiveInt(req.params.session_id);
  if (!sessionId) {
    return res.status(400).json({ error: 'session_id must be a positive integer.' });
  }

  const { restaurant_id, date, address } = req.body ?? {};
  if (!Number.isInteger(restaurant_id) || restaurant_id <= 0) {
    return res.status(400).json({ error: 'restaurant_id must be a positive integer.' });
  }
  // date/address are OPTIONAL now (default to the session's scheduled_for + the
  // host's geocoded location). Validate only when explicitly supplied.
  if (date !== undefined && date !== null) {
    if (typeof date !== 'string' || Number.isNaN(Date.parse(date))) {
      return res.status(400).json({ error: 'date must be a valid date string.' });
    }
  }
  if (address !== undefined && address !== null && typeof address !== 'string') {
    return res.status(400).json({ error: 'address must be a string.' });
  }

  try {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: {
        group: { select: { name: true } },
        members: { select: { user_id: true } },
        host: { select: { display_name: true, username: true } },
      },
    });
    if (!session) {
      return res.status(404).json({ error: 'Session not found.' });
    }
    if (session.host_user_id !== req.user.id) {
      return res.status(403).json({ error: 'Only the host can close the session.' });
    }
    if (session.closed_at) {
      return res.status(409).json({ error: 'Session is already closed.' });
    }

    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurant_id },
      select: { name: true },
    });
    if (!restaurant) {
      return res.status(400).json({ error: 'restaurant_id does not exist.' });
    }

    // occasion + the geocoded primary location live on the HOST's Qa row (set in
    // the pre-session modal). Snapshot them onto the durable Event before the Qa
    // rows are deleted below. The event TIME comes from Session.scheduled_for.
    const hostQa = await prisma.qa.findUnique({
      where: {
        session_id_user_id: { session_id: sessionId, user_id: session.host_user_id },
      },
      select: {
        occasion: true,
        location_address: true,
        location_lat: true,
        location_lon: true,
      },
    });

    // Event date/time from the host's chosen scheduled_for (fall back to now if a
    // legacy session has none); Event.time_slot is its human-readable label.
    const eventDate = date
      ? new Date(date)
      : (session.scheduled_for ?? new Date());
    const eventAddress =
      (typeof address === 'string' && address.trim())
        ? address
        : (hostQa?.location_address ?? 'TBD');

    // Close the session, create the Event, and clear the session's Qa rows
    // atomically. Qa holds each member's TEMPORARY, session-scoped overrides;
    // once the event is created they've served their purpose and are deleted
    // (they never mutate the durable Profile — occasion, the geocoded location,
    // and the chosen time are all preserved on the Event above).
    const [closedSession, event] = await prisma.$transaction([
      prisma.session.update({
        where: { id: sessionId },
        data: { closed_at: new Date() },
      }),
      prisma.event.create({
        data: {
          date: eventDate,
          address: eventAddress,
          lat: hostQa?.location_lat ?? null,
          lon: hostQa?.location_lon ?? null,
          restaurant_id,
          restaurant_name: restaurant.name,
          occasion: hostQa?.occasion ?? null,
          time_slot: formatTimeSlot(eventDate),
          group_id: session.group_id ?? null,
          group_name: session.group?.name ?? null,
          attendees: {
            connect: session.members.map((m) => ({ id: m.user_id })),
          },
        },
      }),
      prisma.qa.deleteMany({ where: { session_id: sessionId } }),
    ]);

    // Announce the confirmed pick (best-effort — never fail the close on a socket/DB
    // hiccup). Two things fan out:
    //   1. A persisted SYSTEM chat message ("X picked <restaurant> for this session")
    //      over the existing chat pipeline, so live clients append it and reloads
    //      replay it in history (mirrors the add/remove-member system lines).
    //   2. session:confirmed to the group room AND every member's per-user room, so a
    //      member viewing the results page (who has left the group room) still learns
    //      the session closed and can be redirected back to the group chat.
    if (session.group_id != null) {
      const io = req.app.get('io');
      const closedAt = closedSession.closed_at?.toISOString?.() ?? new Date().toISOString();

      try {
        const hostName =
          session.host?.display_name ?? session.host?.username ?? 'The host';
        const row = await prisma.groupMessage.create({
          data: {
            group_id: session.group_id,
            user_id: session.host_user_id,
            content: `${restaurant.name} was picked by ${hostName}`,
            message_type: 'SYSTEM',
          },
        });
        io?.to(`group:${session.group_id}`).emit('chat:message', {
          id: String(row.id),
          groupId: session.group_id,
          userId: session.host_user_id,
          name: hostName,
          text: row.content,
          at: row.created_at.toISOString(),
          type: 'system',
        });
      } catch (msgErr) {
        console.error('confirm system message failed', msgErr);
      }

      const payload = { groupId: session.group_id, sessionId, event, closedAt, at: closedAt };
      io?.to(`group:${session.group_id}`).emit('session:confirmed', payload);
      for (const { user_id } of session.members) {
        io?.to(`user:${user_id}`).emit('session:confirmed', payload);
      }
    }

    return res.status(200).json({ session: closedSession, event });
  } catch (err) {
    return next(err);
  }
};

/**
 * GET /api/sessions/:session_id/summary — compact recap of a closed session.
 * 404 missing, 409 when the session is not yet closed.
 */
const getSessionSummary = async (req, res, next) => {
  const sessionId = toPositiveInt(req.params.session_id);
  if (!sessionId) {
    return res.status(400).json({ error: 'session_id must be a positive integer.' });
  }

  try {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: {
        members: { select: { user_id: true } },
      },
    });
    if (!session) {
      return res.status(404).json({ error: 'Session not found.' });
    }
    if (!session.members.some((m) => m.user_id === req.user.id)) {
      return res.status(403).json({ error: 'Not a session member.' });
    }
    if (!session.closed_at) {
      return res.status(409).json({ error: 'Session is not closed.' });
    }

    // The chosen restaurant lives on the Event created at close time. Match on
    // the group's most recent event when present; fall back to none.
    const event = session.group_id
      ? await prisma.event.findFirst({
          where: { group_id: session.group_id },
          orderBy: { id: 'desc' },
        })
      : null;

    // The latest recommendation carries the justification ("reason").
    const recommendation = await prisma.recommendation.findFirst({
      where: { session_id: sessionId },
      orderBy: { created_at: 'desc' },
      include: { items: { orderBy: { match_score: 'desc' }, take: 1 } },
    });

    return res.status(200).json({
      session_id: sessionId,
      closed_at: session.closed_at,
      chosen: event
        ? { restaurant_id: event.restaurant_id, name: event.restaurant_name }
        : null,
      attendees: session.members.map((m) => m.user_id),
      reason: recommendation?.items?.[0]?.justification ?? null,
    });
  } catch (err) {
    return next(err);
  }
};

/**
 * POST /api/sessions/:session_id/analyze — proxy one QA sub-agent turn.
 *
 * Forwards the caller's message to the ai_service conversational agent, which
 * parses it, reconciles against prior signals, and persists the caller's Qa row.
 * The gateway injects the caller's real user_id (never trust a client-supplied
 * one) and requires session membership (403). ai_service host-gates occasion by
 * session.host_user_id, so a non-host can't set event-level fields. Upstream
 * errors pass their status through (e.g. 502 on an LLM failure).
 */
const analyzeTurn = async (req, res, next) => {
  const sessionId = toPositiveInt(req.params.session_id);
  if (!sessionId) {
    return res.status(400).json({ error: 'session_id must be a positive integer.' });
  }

  const { message, message_source, conversation_history, current_signals } =
    req.body ?? {};
  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message is required.' });
  }

  try {
    // Membership guard (mirrors submitQa): only a session member may chat.
    const member = await prisma.sessionMember.findUnique({
      where: { session_id_user_id: { session_id: sessionId, user_id: req.user.id } },
    });
    if (!member) {
      return res.status(403).json({ error: 'Not a session member.' });
    }

    const result = await analyzeTurnAi(sessionId, {
      user_id: req.user.id, // server-verified identity, not client-supplied
      message,
      message_source: message_source ?? 'text',
      conversation_history: conversation_history ?? [],
      current_signals: current_signals ?? {},
    });
    return res.status(200).json(result);
  } catch (err) {
    if (err.response) {
      return res.status(err.response.status).json(err.response.data);
    }
    return next(err);
  }
};

/**
 * POST /api/geocode — validate + geocode a free-text address to coordinates.
 *
 * Used by the host pre-session modal to confirm a location resolves before
 * "Start session" proceeds. Returns { ok, lat, lon } on a hit, or { ok:false }
 * (200) when the address can't be resolved — the client treats a miss as an
 * inline "couldn't find that" hint, not an error. The Geocodio key stays
 * server-side (never exposed to the browser).
 */
const validateGeocode = async (req, res, next) => {
  const { address } = req.body ?? {};
  if (typeof address !== 'string' || !address.trim()) {
    return res.status(400).json({ error: 'address is required.' });
  }
  try {
    const coords = await geocode(address);
    if (!coords) {
      return res.status(200).json({ ok: false });
    }
    return res.status(200).json({ ok: true, lat: coords.lat, lon: coords.lon });
  } catch (err) {
    return next(err);
  }
};

export {
  getRecommendations,
  createSession,
  getSession,
  joinSession,
  listMembers,
  setReady,
  submitQa,
  getLatestRecommendation,
  closeSession,
  getSessionSummary,
  analyzeTurn,
  validateGeocode,
};
