// HTTP client proxying AI/RAG calls to the FastAPI ai_service.
import axios from 'axios';
import { config } from '../config/index.js';

const client = axios.create({
  baseURL: config.aiServiceUrl,
  // Embedding tail latency can be high (cold provider routing on OpenRouter),
  // so allow generous headroom before giving up and storing a NULL embedding.
  timeout: 120_000,
  headers: {
    // Shared internal secret so /embed isn't openly callable. Must match the
    // ai_service JWT_SECRET (see app/api/deps.py).
    'X-Internal-Secret': config.jwtSecret,
  },
});

/**
 * Generate an embedding vector for the given text via the ai_service.
 * @param {string} text
 * @returns {Promise<number[]>} the embedding (1024 floats)
 */
const embed = async (text) => {
  const { data } = await client.post('/api/v1/embed', { text });
  return data.embedding;
};

/**
 * Trigger the group orchestrator for a session and return its ranked picks.
 * @param {number} sessionId
 * @param {{ forcePartial?: boolean }} [opts] forcePartial bypasses the
 *   all-members-confirmed guard on the ai_service side.
 * @returns {Promise<object>} RecommendationOut: { id, session_id, created_at, items: [...] }
 */
const getRecommendations = async (sessionId, { forcePartial = false } = {}) => {
  const { data } = await client.post(
    `/api/v1/sessions/${sessionId}/recommendations`,
    { force_partial: forcePartial },
  );
  return data;
};

/**
 * Proxy one conversational QA sub-agent turn to the ai_service. The ai_service
 * parses the message, reconciles it against prior signals, persists the member's
 * session-scoped Qa row (host-only occasion gated server-side), and returns the
 * updated signals + agent reply + still-missing questions.
 * @param {number} sessionId
 * @param {object} body AnalyzeRequest: { user_id, message, message_source?,
 *   conversation_history?, current_signals? }
 * @returns {Promise<object>} AnalyzeResponse: { user_id, session_id,
 *   extracted_signals, profile_updated, qa_updated, agent_reply, missing_signals }
 */
const analyzeTurn = async (sessionId, body) => {
  const { data } = await client.post(
    `/api/v1/sessions/${sessionId}/analyze`,
    body,
  );
  return data;
};

/**
 * Render the fixed voice-preview line in one of the selectable Cartesia voices.
 *
 * Returns raw WAV bytes, NOT JSON — hence `responseType: 'arraybuffer'`, without
 * which axios would coerce the binary body to a UTF-8 string and corrupt it. The
 * ai_service caches each voice's clip in-process, so a repeat request costs a
 * round trip and nothing else.
 *
 * @param {string|null} voiceId a Cartesia voice id; unknown/null → server default
 * @returns {Promise<{ audio: Buffer, contentType: string }>}
 */
const previewVoice = async (voiceId) => {
  const res = await client.post(
    '/api/v1/voice/preview',
    { voice_id: voiceId ?? null },
    // Well under the shared 120s: this is one short TTS call, and a user waiting
    // on a preview button should get an error long before two minutes.
    { responseType: 'arraybuffer', timeout: 20_000 },
  );
  return {
    audio: Buffer.from(res.data),
    contentType: res.headers['content-type'] ?? 'audio/wav',
  };
};

export { embed, getRecommendations, analyzeTurn, previewVoice };
