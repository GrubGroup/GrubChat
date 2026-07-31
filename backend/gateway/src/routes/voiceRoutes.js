// Routes for /voice — the HTTP side of the voice feature. The live turn-loop is
// a WebSocket (sockets/voiceHandlers.js) and is not routed here.
import { Router } from 'express';
import { requireAuth } from '../middleware/authMiddleware.js';
import { previewVoice } from '../controllers/voiceController.js';

const router = Router();

// Auth-guarded: each uncached preview is a paid TTS generation upstream, so this
// must not be open to anonymous callers.
router.post('/preview', requireAuth, previewVoice);

export default router;
