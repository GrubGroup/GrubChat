// Upstream WebSocket client to the ai_service voice relay.
//
// Opens ONE ws:// connection to ai_service `/api/v1/voice/session` per member
// voice turn-loop, authenticated with the same shared internal secret the axios
// aiClient uses (X-Internal-Secret === config.jwtSecret). Audio and control
// frames are relayed verbatim; the gateway is a thin authenticated pass-through
// (it does NOT parse audio), so audio bytes never reach the browser vendor-direct
// and no long-lived vendor key is ever exposed client-side.
//
// TRANSPORT NOTES (verified against Bun, not assumed):
//   * Native GLOBAL `WebSocket` — NOT the `ws` package. Under Bun `import "ws"`
//     is a shim over this same global one layer deeper; the global accepts a
//     `{ headers }` option (confirmed) so there is no reason for the dependency.
//   * With `binaryType = 'nodebuffer'`, incoming TEXT frames arrive as a JS
//     `string` and BINARY frames as a `Buffer` (confirmed by round-trip). So the
//     receive path branches on `typeof data === 'string'`, never on an
//     `isBinary` argument (that is the `ws` package's API, which we don't use).
//   * `perMessageDeflate: false` — PCM does not compress and deflate doubles
//     per-frame CPU. Matches the ai_service `--ws-per-message-deflate false`.
import { config } from '../config/index.js';

/** Derive the ws(s):// base from the http(s):// ai_service URL. */
const wsBase = () => config.aiServiceUrl.replace(/^http/, 'ws');

/**
 * Open an authenticated upstream voice WS for one (session, user).
 *
 * @param {number} sessionId
 * @param {number} userId  server-verified caller id (never client-supplied)
 * @param {{
 *   onText: (frame: object) => void,   // a parsed JSON control frame
 *   onAudio: (pcm: Buffer) => void,    // a binary TTS chunk
 *   onOpen?: () => void,
 *   onClose?: (code: number, reason: string) => void,
 *   onError?: (err: Error) => void,
 * }} handlers
 * @returns {{
 *   sendAudio: (chunk: ArrayBuffer|Buffer|Uint8Array) => void,
 *   sendControl: (frame: object) => void,
 *   close: () => void,
 *   isOpen: () => boolean,
 * }}
 */
const openVoiceUpstream = (sessionId, userId, handlers) => {
  const url =
    `${wsBase()}/api/v1/voice/session` +
    `?session_id=${encodeURIComponent(sessionId)}` +
    `&user_id=${encodeURIComponent(userId)}`;

  const ws = new WebSocket(url, {
    headers: { 'X-Internal-Secret': config.jwtSecret },
    perMessageDeflate: false,
  });
  ws.binaryType = 'nodebuffer';

  ws.addEventListener('open', () => handlers.onOpen?.());

  ws.addEventListener('message', (ev) => {
    const data = ev.data;
    // TEXT frame -> JSON control; BINARY frame (Buffer) -> TTS audio. Branch on
    // the runtime type because that is what Bun's native client actually gives
    // us (string vs Buffer), and it never conflates the two.
    if (typeof data === 'string') {
      let frame;
      try {
        frame = JSON.parse(data);
      } catch {
        return; // ignore a non-JSON text frame rather than crash the relay
      }
      handlers.onText(frame);
    } else {
      handlers.onAudio(data);
    }
  });

  ws.addEventListener('close', (ev) =>
    handlers.onClose?.(ev.code ?? 1006, ev.reason ?? ''),
  );
  // NOTE: under Bun a failed handshake (bad secret / 404 / machine down) all
  // surface here identically as an error/`close 1002 "Expected 101 status
  // code"` — the upstream HTTP status is NOT readable client-side. So callers
  // must NOT assert authorization on this code; the gateway enforces membership
  // itself before ever opening this socket.
  ws.addEventListener('error', (ev) =>
    handlers.onError?.(ev instanceof Error ? ev : new Error(String(ev?.message ?? 'voice upstream error'))),
  );

  const isOpen = () => ws.readyState === WebSocket.OPEN;

  return {
    sendAudio: (chunk) => {
      if (isOpen()) ws.send(chunk);
    },
    sendControl: (frame) => {
      if (isOpen()) ws.send(JSON.stringify(frame));
    },
    close: () => {
      // 1000 = normal closure. Guard: closing an already-closed socket throws.
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        try {
          ws.close(1000);
        } catch {
          /* already closing/closed */
        }
      }
    },
    isOpen,
  };
};

export { openVoiceUpstream };
