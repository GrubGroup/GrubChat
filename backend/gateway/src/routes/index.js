// Route aggregator: mounts restaurants, sessions, profile, user, users, groups,
// events, and voice under /api.
//
// Auth endpoints are NOT here — Better Auth owns /api/auth/* directly in app.js.
// The liveness probe is GET /health, defined in app.js (it's what fly.toml checks).
import { Router } from 'express';
import restaurantsRouter from './restaurantsRoutes.js';
import sessionsRouter from './sessionsRoutes.js';
import profileRouter from './profileRoutes.js';
import userRouter from './userRoutes.js';
import groupsRouter from './groupsRoutes.js';
import usersRouter from './usersRoutes.js';
import eventsRouter from './eventsRoutes.js';
import voiceRouter from './voiceRoutes.js';
import { getAuthMethods } from '../controllers/authMethodsController.js';
import { validateGeocode } from '../controllers/sessionsController.js';
import { requireAuth } from '../middleware/authMiddleware.js';

const router = Router();

// Public: which auth providers an email has (used pre-login by the sign-in form).
router.get('/auth-methods', getAuthMethods);

// Validate + geocode a free-text address (host pre-session modal). Keeps the
// Geocodio key server-side. Auth-guarded so it isn't an open geocoding proxy.
router.post('/geocode', requireAuth, validateGeocode);

router.use('/restaurants', restaurantsRouter);
router.use('/sessions', sessionsRouter);
router.use('/profile', profileRouter);
router.use('/user', userRouter);
router.use('/groups', groupsRouter);
router.use('/users', usersRouter);
router.use('/events', eventsRouter);
router.use('/voice', voiceRouter);

export default router;
