// Live group-chat message — the shape broadcast by the gateway over Socket.IO
// (and replayed from persisted history on join). Frontend-shaped, aligned to the
// gateway's `toWireMessage` output (sockets/sessionHandlers.js).

export interface GroupMessage {
  id: string
  groupId: number
  userId: number | null // DEV: unverified handshake identity for now
  name?: string | null
  // Sender's OAuth profile photo (Better Auth image); null for email/password
  // users, where the chat avatar falls back to colored initials.
  avatarUrl?: string | null
  text: string
  at: string // ISO timestamp
  // 'system' renders as a centered divider (e.g. "Sophie has left the group").
  // Absent/'text' is a normal chat bubble. 'session_block' is a LEGACY type kept
  // only so a persisted recommendation row (from before recommendations moved to
  // the results flow) is recognized and swallowed rather than rendered.
  type?: 'text' | 'system' | 'session_block'
}
