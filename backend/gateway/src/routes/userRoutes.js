// Routes for /user — read and update the caller's own account identity.
import { Router } from 'express';
import { requireAuth } from '../middleware/authMiddleware.js';
import { getMe, updateMe, deactivateMe } from '../controllers/userController.js';

const router = Router();

// Every user route is caller-scoped and requires a valid session.
router.use(requireAuth);

router.get('/me', getMe);
router.patch('/', updateMe);
// Soft-delete ("delete account"): deactivate + scrub identity, revoke sessions,
// leave all groups. See deactivateMe.
router.delete('/', deactivateMe);

export default router;
