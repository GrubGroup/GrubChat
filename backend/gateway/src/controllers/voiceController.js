// Voice request handlers.
//
// The live voice LOOP is a WebSocket and lives in sockets/voiceHandlers.js; this
// file is the plain-HTTP side of the voice feature — currently just the settings
// screen's voice preview.
import { previewVoice as previewVoiceUpstream } from '../services/aiClient.js';
import { logger } from '../utils/logger.js';

/**
 * POST /api/voice/preview — a short WAV of the fixed preview line, spoken in the
 * requested voice, so the settings picker can be auditioned without joining a
 * session.
 *
 * Proxied rather than called from the browser for the same reason every other AI
 * call is: the Cartesia key lives on ai_service and the hop is authenticated with
 * the shared internal secret. Auth-guarded at the route so it isn't a free
 * text-to-speech endpoint for the internet — the transcript is fixed server-side,
 * but the generation still costs money per uncached voice.
 */
const previewVoice = async (req, res, next) => {
  // The id is validated against the allowlist on the ai_service side
  // (voices.resolve_voice_id), which falls back to the configured default — so a
  // junk value here is a wrong-sounding preview at worst, never an upstream error.
  const voiceId = typeof req.body?.voice_id === 'string' ? req.body.voice_id : null;

  try {
    const { audio, contentType } = await previewVoiceUpstream(voiceId);
    res.set('Content-Type', contentType);
    // Same fixed line + same voice = the same bytes forever, so let the browser
    // keep it. Private: it rides an authenticated request and shared caches
    // shouldn't hold it.
    res.set('Cache-Control', 'private, max-age=86400');
    return res.status(200).send(audio);
  } catch (err) {
    // Surface the upstream's own verdict where it has one: 503 "not configured /
    // busy" and 502 "upstream failed" mean different things to the button, and
    // collapsing both into a 500 would tell the user to retry a missing API key.
    const upstream = err?.response?.status;
    if (upstream === 503 || upstream === 502) {
      logger.error('voice preview upstream failed:', upstream);
      return next({
        status: upstream,
        message:
          upstream === 503
            ? 'Voice previews are unavailable right now. Try again in a moment.'
            : 'Could not generate a voice preview.',
      });
    }
    return next(err);
  }
};

export { previewVoice };
