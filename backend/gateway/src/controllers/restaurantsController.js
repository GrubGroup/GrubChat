// Restaurant request handlers: browse/detail, create-then-embed, and like/unlike.
import { prisma } from '../lib/prisma.js';
import { embed } from '../services/aiClient.js';
import { logger } from '../utils/logger.js';

const EMBEDDING_DIMS = 1024;

const DEFAULT_LIST_LIMIT = 20;
// Per-request ceiling. Kept generous so the frontend can page the FULL catalog
// (~2k+ rows) into its client-side store — the Explore/Top Picks/Profile views
// resolve restaurant ids against that store, so a low cap silently drops any
// row not loaded. The default (20) still protects future unpaginated callers.
const MAX_LIST_LIMIT = 1000;

/** Parse a route param to a positive integer, or null when invalid. */
const toPositiveInt = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * Build the text we embed from a restaurant's descriptive fields.
 * @param {{ name?: string, description?: string, cuisine_tags?: string[] }} r
 */
const buildEmbedText = (r) =>
  [r.name, r.description, (r.cuisine_tags ?? []).join(', ')]
    .filter(Boolean)
    .join('. ');

/**
 * Persist a restaurant's embedding via raw SQL. Prisma can't write the
 * Unsupported("vector(1024)") column through its typed API, so we cast a
 * vector literal string with ::vector. The literal and id are bound params.
 * @param {number} id
 * @param {number[]} embedding
 */
const storeEmbedding = async (id, embedding) => {
  if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMS) {
    throw new Error(
      `Expected ${EMBEDDING_DIMS}-dim embedding, got ${embedding?.length}`,
    );
  }
  const literal = `[${embedding.join(',')}]`;
  await prisma.$executeRaw`
    UPDATE "Restaurant" SET embedding = ${literal}::vector WHERE id = ${id}
  `;
};

/**
 * GET /api/restaurants?q=&cuisine=&dietary=&price_max=&limit=&offset= —
 * browse/filter restaurants. Prisma omits the Unsupported embedding column
 * automatically, so the typed result never leaks the vector.
 */
const listRestaurants = async (req, res, next) => {
  const { q, cuisine, dietary, price_max, limit, offset } = req.query;

  let take = DEFAULT_LIST_LIMIT;
  if (limit !== undefined) {
    const parsed = Number(limit);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return res.status(400).json({ error: 'limit must be a positive integer.' });
    }
    take = Math.min(parsed, MAX_LIST_LIMIT);
  }

  let skip = 0;
  if (offset !== undefined) {
    const parsed = Number(offset);
    if (!Number.isInteger(parsed) || parsed < 0) {
      return res.status(400).json({ error: 'offset must be a non-negative integer.' });
    }
    skip = parsed;
  }

  let priceMax;
  if (price_max !== undefined) {
    priceMax = Number(price_max);
    if (Number.isNaN(priceMax)) {
      return res.status(400).json({ error: 'price_max must be a number.' });
    }
  }

  const where = {};
  if (q) {
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { description: { contains: q, mode: 'insensitive' } },
    ];
  }
  if (cuisine) {
    where.cuisine_tags = { has: cuisine };
  }
  if (dietary) {
    // Support a single tag or a comma-separated list; require all of them.
    const tags = String(dietary).split(',').map((t) => t.trim()).filter(Boolean);
    where.dietary_tags = { hasEvery: tags };
  }
  if (priceMax !== undefined) {
    where.price_avg = { lte: priceMax };
  }

  try {
    const restaurants = await prisma.restaurant.findMany({
      where,
      orderBy: { id: 'asc' },
      take,
      skip,
    });
    return res.status(200).json(restaurants);
  } catch (err) {
    return next(err);
  }
};

/**
 * GET /api/restaurants/:restaurant_id — restaurant detail. 404 when missing.
 */
const getRestaurant = async (req, res, next) => {
  const restaurantId = toPositiveInt(req.params.restaurant_id);
  if (!restaurantId) {
    return res.status(400).json({ error: 'restaurant_id must be a positive integer.' });
  }

  try {
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
    });
    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found.' });
    }
    return res.status(200).json(restaurant);
  } catch (err) {
    return next(err);
  }
};

/**
 * POST /api/restaurants — create a restaurant, then synchronously embed it.
 *
 * The row is created first so it owns the id we update. Because embedding is
 * nullable, a failed embed leaves a valid (not-yet-searchable) restaurant
 * rather than losing the whole creation — we return 201 either way.
 */
const createRestaurant = async (req, res, next) => {
  const {
    name,
    description,
    cuisine_tags,
    dietary_tags,
    price_avg,
    address,
    lat,
    long,
    hours,
    avg_rating,
  } = req.body ?? {};

  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }

  let restaurant;
  try {
    // 1. Create the row (embedding stays NULL for now).
    restaurant = await prisma.restaurant.create({
      data: {
        name,
        description: description ?? null,
        cuisine_tags: cuisine_tags ?? [],
        dietary_tags: dietary_tags ?? [],
        price_avg: price_avg ?? null,
        address: address ?? null,
        lat: lat ?? null,
        long: long ?? null,
        hours: hours ?? null,
        avg_rating: avg_rating ?? null,
      },
    });
  } catch (err) {
    return next(err);
  }

  // 2-3. Generate + persist the embedding. On failure, log and continue —
  // the restaurant exists with embedding=NULL and can be backfilled later.
  try {
    const embedding = await embed(buildEmbedText(restaurant));
    await storeEmbedding(restaurant.id, embedding);
  } catch (err) {
    logger.error(
      `Embedding failed for restaurant ${restaurant.id}; stored with NULL embedding.`,
      err.message,
    );
  }

  // 4. Return the created restaurant. Re-read is unnecessary — the embedding
  // column isn't exposed through Prisma's typed client anyway.
  return res.status(201).json(restaurant);
};

/**
 * POST /api/restaurants/:restaurant_id/like — append the restaurant to the
 * caller's liked list (idempotent). 404 when the restaurant does not exist.
 * Creates a minimal profile if the caller has none yet.
 */
const likeRestaurant = async (req, res, next) => {
  const restaurantId = toPositiveInt(req.params.restaurant_id);
  if (!restaurantId) {
    return res.status(400).json({ error: 'restaurant_id must be a positive integer.' });
  }

  try {
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { id: true },
    });
    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found.' });
    }

    // Atomic upsert: create a minimal profile if the caller has none (same seed
    // as before — empty arrays, zero budget), else append idempotently. Done in a
    // single statement so concurrent likes can't lose an update — the DO UPDATE's
    // array_append reads the row under the lock the upsert holds. A plain
    // findUnique-then-update would race (two requests read the old array, the
    // second write clobbers the first).
    const rows = await prisma.$queryRaw`
      INSERT INTO "Profile"
        (user_id, dietary_restrictions, disliked_cuisines, preferred_cuisines,
         budget_min, budget_max, liked_restaurant_ids, created_at, updated_at)
      VALUES
        (${req.user.id}, '{}'::text[], '{}'::text[], '{}'::text[], 0, 0,
         ARRAY[${restaurantId}::int], now(), now())
      ON CONFLICT (user_id) DO UPDATE SET
        liked_restaurant_ids = CASE
          WHEN ${restaurantId}::int = ANY("Profile".liked_restaurant_ids)
            THEN "Profile".liked_restaurant_ids
          ELSE array_append("Profile".liked_restaurant_ids, ${restaurantId}::int)
        END,
        updated_at = now()
      RETURNING liked_restaurant_ids
    `;
    return res.status(200).json({ liked_restaurant_ids: rows[0].liked_restaurant_ids });
  } catch (err) {
    return next(err);
  }
};

/**
 * DELETE /api/restaurants/:restaurant_id/like — remove the restaurant from the
 * caller's liked list. 404 when the restaurant does not exist.
 */
const unlikeRestaurant = async (req, res, next) => {
  const restaurantId = toPositiveInt(req.params.restaurant_id);
  if (!restaurantId) {
    return res.status(400).json({ error: 'restaurant_id must be a positive integer.' });
  }

  try {
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { id: true },
    });
    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found.' });
    }

    // Atomic single-statement remove — no read-then-write race. 0 rows updated
    // (the caller has no profile) yields an empty liked list, as before.
    const rows = await prisma.$queryRaw`
      UPDATE "Profile"
         SET liked_restaurant_ids = array_remove(liked_restaurant_ids, ${restaurantId}::int),
             updated_at = now()
       WHERE user_id = ${req.user.id}
       RETURNING liked_restaurant_ids
    `;
    return res.status(200).json({ liked_restaurant_ids: rows[0]?.liked_restaurant_ids ?? [] });
  } catch (err) {
    return next(err);
  }
};

export {
  listRestaurants,
  getRestaurant,
  createRestaurant,
  likeRestaurant,
  unlikeRestaurant,
};
