// Modeled on Prisma `Session` + `SessionMember`.
// NOTE: Prisma has NO session-status enum. Per-member readiness is
// `SessionMember.status: boolean`. `SessionPhase` below is FRONTEND-ONLY UI
// state derived from members/recommendation — it is never persisted.

export interface Session {
  id: number
  host_user_id: number
  group_id?: number | null
  time_limit: number
  // The host's chosen event time (pre-session modal). Drives the open/closed
  // hard filter server-side and is snapshotted onto Event.date at close. Null on
  // legacy sessions created before the field existed.
  scheduled_for?: string | null
  created_at: string
  closed_at?: string | null
}

export interface SessionMember {
  // The gateway's getSession/listMembers reads DON'T return session_id (it's
  // implied by the route), but they DO return the member's display_name and
  // username. Model the actual wire shape: session_id optional, name fields
  // present (username is the fallback when display_name is null).
  session_id?: number
  user_id: number
  display_name?: string | null
  username?: string | null
  // OAuth profile photo (Better Auth image); null for email/password users,
  // where session avatars fall back to colored initials.
  avatar_url?: string | null
  status: boolean // true = done sharing preferences
  joined_at: string
}

// FRONTEND-ONLY: drives which screen shows. Not a DB field.
export type SessionPhase =
  | 'joining'
  | 'waiting'
  | 'chatting'
  | 'done'
  | 'picks'
  | 'detail'
  | 'complete'
