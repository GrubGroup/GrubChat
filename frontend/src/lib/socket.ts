import { io, type Socket } from 'socket.io-client'
import { GATEWAY_URL } from './env'

// Real-time lives in the gateway (Socket.IO). useSocket() subscribes to gateway
// events and dispatches them into the stores.
let socket: Socket | null = null

export interface SocketAuth {
  // The gateway authenticates the handshake from the Better Auth session cookie
  // (sent via withCredentials); connections without a valid session are rejected.
  // Identity (userId/role) is read from the verified session server-side —
  // `name` is only a cosmetic display label.
  name?: string
}

// Returns the singleton socket, creating it on first call with the given auth.
// Later calls ignore the arg and return the existing connection.
export function getSocket(auth?: SocketAuth): Socket | null {
  if (!socket) {
    socket = io(GATEWAY_URL, {
      auth: auth ?? undefined,
      withCredentials: true,
      autoConnect: true,
      // Pin the WebSocket transport (no long-polling fallback). engine.io defaults
      // to ['polling','websocket'], which for the first few hundred ms of a voice
      // session base64-bloats mic audio over polling POSTs AND hard-blocks it during
      // the upgrade pause (buffered, then flushed as one out-of-realtime burst) —
      // enough to corrupt Flux's endpointing and trip a spurious EndOfTurn. Transports
      // are a Manager-level option (not per-namespace) and this is the one singleton
      // socket shared with group chat, so pinning it here removes polling for chat too
      // — acceptable on this stack, and Socket.IO's own recommendation.
      transports: ['websocket'],
    })
  }
  return socket
}
