// A group (chat room). Mirrors the useful bits of Prisma `Group` (id, name) plus
// UI-only fields for the sidebar list.

// The most recent message in a group, used for the sidebar preview line.
export interface GroupLastMessage {
  text: string
  name: string | null
  user_id: number
  at: string // ISO timestamp
}

export interface Group {
  id: number
  name: string
  // When the group was created (ISO). From GET /api/groups[/:id]; may be absent.
  created_at?: string
  // Latest message from the DB (null when the group has no messages yet).
  last_message?: GroupLastMessage | null
  // Member count from GET /api/groups (UI only; may be absent).
  member_count?: number
  preview?: string // last-message preview (UI only; optional fallback)
  time?: string // relative time label, e.g. "2m" (UI only; optional fallback)
}

// A group member, as returned by GET /api/groups/:id (joined to User).
export interface GroupMember {
  user_id: number
  display_name: string | null
  avatar_url?: string | null
  joined_at: string
}

// Full group detail (group + its members), from GET /api/groups/:id.
export interface GroupDetail extends Group {
  members: GroupMember[]
}
