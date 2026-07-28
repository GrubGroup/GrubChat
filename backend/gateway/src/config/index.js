// Loads and validates environment configuration.
import 'dotenv/config';

// Fail fast if the Better Auth secret is missing — it signs/encrypts sessions.
const BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET;
if (!BETTER_AUTH_SECRET) {
  throw new Error('BETTER_AUTH_SECRET is required (used to sign/encrypt sessions).');
}

const PORT = Number(process.env.PORT) || 4000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';
const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://localhost:8000';

const config = {
  PORT,
  // Must match the Vite dev server origin so the browser can open the socket
  // and send credentialed (cookie) requests.
  CORS_ORIGIN,

  // Auth — Better Auth (cookie sessions). baseURL must match the real origin so
  // OAuth callbacks resolve; defaults to this gateway's own address.
  BETTER_AUTH_SECRET,
  BETTER_AUTH_URL: process.env.BETTER_AUTH_URL || `http://localhost:${PORT}`,

  // Google OAuth (server-side code exchange — both id + secret required).
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '',

  // Downstream FastAPI service. Consumed by the AI proxy client
  // (services/aiClient.js) via the camelCase alias. The gateway->ai_service hop
  // authenticates with JWT_SECRET sent as the X-Internal-Secret header, so it
  // stays alongside the Better Auth config.
  aiServiceUrl: AI_SERVICE_URL,
  jwtSecret: process.env.JWT_SECRET || '',

  // Geocodio API key — used to turn a member's address into lat/lon at write
  // time (services/geocodeClient.js). Optional: absent key degrades gracefully
  // (addresses save with null coordinates rather than blocking the request).
  geocodioApiKey: process.env.GEOCODIO_API || '',

  // Cross-site cookies (prod only). When the frontend and gateway are on
  // DIFFERENT domains (e.g. Render frontend ↔ Fly gateway), the Better Auth
  // session cookie must be SameSite=None; Secure to ride cross-site. Off by
  // default so local http dev keeps first-party Lax cookies via the Vite proxy.
  crossSiteCookies: process.env.CROSS_SITE_COOKIES === 'true',
};

export { config };
