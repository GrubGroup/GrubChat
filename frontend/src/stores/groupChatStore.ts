import { create } from 'zustand'
import type { GroupMessage } from '@/types'
import { getSocket } from '@/lib/socket'

// Live group chat. Messages arrive from the gateway over Socket.IO and are the
// single source of truth: sendMessage() only emits — it does NOT optimistically
// append; the server echoes the message back to everyone (incl. the sender),
// and receiveMessage() appends it. This avoids duplicates and drift.
//
// Session start is broadcast the same way: startSession() emits, and the server
// echoes 'session:start' to everyone in the room, which calls receiveSessionStart
// so every client shows the session card live — inline, after the messages that
// existed when it started.

// A person currently typing in a group. `at` is a client-side timestamp used
// only for auto-expiry (clearing a ghost indicator if a stop event is missed).
export interface Typer {
  userId: number | null
  name: string | null
  // OAuth photo carried on the typing broadcast; null → colored-initials fallback.
  avatarUrl: string | null
  at: number
}

interface TypingUpdate {
  groupId: number
  userId: number | null
  name: string | null
  avatarUrl?: string | null
  isTyping: boolean
}

interface GroupChatState {
  messagesByGroup: Record<number, GroupMessage[]>
  // Per group: true once the persisted backlog (chat:history) has been received,
  // so the UI can tell "still loading history" from "loaded, no messages".
  historyLoadedByGroup: Record<number, boolean>
  // Per group: index in the message list where the session card belongs, or null
  // if no session has started. null = not started.
  sessionStartIndexByGroup: Record<number, number | null>
  // Per group: who is currently typing (ephemeral presence, never persisted).
  typingByGroup: Record<number, Typer[]>
  receiveMessage: (msg: GroupMessage) => void
  // Replay of persisted backlog for a group, sent by the gateway on join.
  receiveHistory: (groupId: number, messages: GroupMessage[]) => void
  sendMessage: (groupId: number, text: string) => void
  // Host emits after creating the Session over REST; sessionId lets other members
  // adopt the same session. Omitted for a legacy/no-op start.
  startSession: (groupId: number, sessionId?: number) => void
  receiveSessionStart: (groupId: number, sessionId?: number | null) => void
  // Reset a group's session-start marker to null so a NEW session can place a
  // fresh card. receiveSessionStart ignores a repeat start while a marker exists
  // (dedupe), so this must be called when starting another session after one
  // completes — else the guard silently swallows the new start.
  clearSessionStart: (groupId: number) => void
  setTyping: (groupId: number, isTyping: boolean) => void
  receiveTyping: (update: TypingUpdate) => void
}

// Stable empty reference so the messagesFor selector never returns a fresh
// array (which would loop under React 19 StrictMode). Mirrors MenuList's EMPTY.
const EMPTY: GroupMessage[] = []
const EMPTY_TYPERS: Typer[] = []

export const useGroupChatStore = create<GroupChatState>((set) => ({
  messagesByGroup: {},
  historyLoadedByGroup: {},
  sessionStartIndexByGroup: {},
  typingByGroup: {},

  receiveMessage: (msg) => {
    // Recommendations live in the session/results flow, never the chat — drop any
    // legacy SESSION_BLOCK row so it can't surface as a blank bubble.
    if (msg.type === 'session_block') return
    set((s) => ({
      messagesByGroup: {
        ...s.messagesByGroup,
        [msg.groupId]: [...(s.messagesByGroup[msg.groupId] ?? EMPTY), msg],
      },
    }))
  },

  // Seed a group's messages from the persisted backlog. Replaces the list
  // (set, not append) so a reload/late-join starts from the stored history;
  // subsequent live receiveMessage calls append after it. Legacy SESSION_BLOCK
  // rows are filtered out (recommendations moved to the results flow).
  receiveHistory: (groupId, messages) =>
    set((s) => ({
      messagesByGroup: {
        ...s.messagesByGroup,
        [groupId]: messages.filter((m) => m.type !== 'session_block'),
      },
      historyLoadedByGroup: { ...s.historyLoadedByGroup, [groupId]: true },
    })),

  sendMessage: (groupId, text) => {
    const trimmed = text.trim()
    if (!trimmed) return
    // Fire-and-forget: the message renders when the server echoes it back.
    getSocket()?.emit('chat:message', { groupId, text: trimmed })
  },

  // Emit only — the card appears when the server echoes 'session:start' back.
  // The host passes the freshly-created sessionId so every member adopts it.
  startSession: (groupId, sessionId) => {
    getSocket()?.emit('session:start', { groupId, sessionId })
  },

  // Record the session-start point at the current message count for this group,
  // so the card renders inline after existing messages. Ignore repeat starts.
  // (The sessionId is consumed by useSocket to adopt the session in sessionStore;
  // the store here only tracks where the card renders.)
  receiveSessionStart: (groupId) =>
    set((s) => {
      if (s.sessionStartIndexByGroup[groupId] != null) return s
      const count = (s.messagesByGroup[groupId] ?? EMPTY).length
      return {
        sessionStartIndexByGroup: { ...s.sessionStartIndexByGroup, [groupId]: count },
      }
    }),

  clearSessionStart: (groupId) =>
    set((s) => ({
      sessionStartIndexByGroup: { ...s.sessionStartIndexByGroup, [groupId]: null },
    })),

  // Emit only — tell the gateway I started/stopped typing. Nothing local changes;
  // the indicator for OTHERS is driven by their receiveTyping.
  setTyping: (groupId, isTyping) => {
    getSocket()?.emit(isTyping ? 'typing:start' : 'typing:stop', { groupId })
  },

  // A typing:update arrived from another member. Add/refresh them (bump `at`) or
  // remove them from this group's list. De-duped by userId; immutable spread.
  receiveTyping: ({ groupId, userId, name, avatarUrl, isTyping }) =>
    set((s) => {
      const current = s.typingByGroup[groupId] ?? EMPTY_TYPERS
      const without = current.filter((t) => t.userId !== userId)
      const next = isTyping
        ? [...without, { userId, name, avatarUrl: avatarUrl ?? null, at: Date.now() }]
        : without
      return { typingByGroup: { ...s.typingByGroup, [groupId]: next } }
    }),
}))

// Selector helper: returns the stable EMPTY array when a group has no messages.
export const selectGroupMessages = (groupId: number) => (s: GroupChatState) =>
  s.messagesByGroup[groupId] ?? EMPTY

// Selector: whether this group's persisted backlog has been received yet.
export const selectHistoryLoaded = (groupId: number) => (s: GroupChatState) =>
  s.historyLoadedByGroup[groupId] ?? false

// Selector: the message index where the session card belongs, or null.
export const selectSessionStartIndex = (groupId: number) => (s: GroupChatState) =>
  s.sessionStartIndexByGroup[groupId] ?? null

// Selector: who is currently typing in this group (stable EMPTY when none).
export const selectTypers = (groupId: number) => (s: GroupChatState) =>
  s.typingByGroup[groupId] ?? EMPTY_TYPERS
