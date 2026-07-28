import { create } from 'zustand'
import { isAxiosError } from 'axios'
import type { Group, GroupLastMessage } from '@/types'
import { fetchGroups, createGroup, addGroupMember, removeGroupMember } from '@/api/groupsApi'

// The user's group list, loaded from the gateway (each group carries its latest
// DB message as last_message, for the sidebar preview). Create + invite hit the
// real gateway endpoints (the caller is auto-added as a member server-side).

// Result of an invite attempt, so the UI can show success/error inline.
export interface InviteResult {
  ok: boolean
  error?: string
}

// The group to land in after sign-in: newest last message first, matching how
// GroupsSidebar sorts its list (message-less groups have no timestamp → 0, so
// they sink last). Returns undefined when the list is empty.
export function mostRecentGroup(groups: Group[]): Group | undefined {
  const activity = (g: Group) => {
    const ms = g.last_message?.at ? new Date(g.last_message.at).getTime() : 0
    return Number.isNaN(ms) ? 0 : ms
  }
  return groups.reduce<Group | undefined>(
    (best, g) => (best && activity(best) >= activity(g) ? best : g),
    undefined,
  )
}

interface GroupsState {
  groups: Group[]
  // True once load() has settled at least once (success OR failure). Lets the UI
  // distinguish "no groups" from "not loaded yet" so it never redirects a valid
  // member off a chat while the list is still in flight. Mock mode is seeded, so
  // it starts true.
  loaded: boolean
  load: () => Promise<void>
  // Patch one group's last_message from a live socket preview, so the sidebar
  // preview + sort update without a full refetch (no-op if the group isn't loaded).
  applyPreview: (groupId: number, last_message: GroupLastMessage) => void
  reset: () => void
  addGroup: (name: string, memberIds?: number[]) => Promise<Group>
  inviteMember: (groupId: number, username: string) => Promise<InviteResult>
  // Leave a group (remove yourself), then drop it from the list.
  leaveGroup: (groupId: number, userId: number) => Promise<void>
}

export const useGroupsStore = create<GroupsState>((set, get) => ({
  // Starts empty and is filled by load() from the gateway.
  groups: [],
  loaded: false,

  // Refresh the list from the backend. Clear on failure so one account never
  // shows another account's groups. Either way, mark loaded so membership
  // becomes knowable.
  load: async () => {
    try {
      set({ groups: await fetchGroups(), loaded: true })
    } catch {
      set({ groups: [], loaded: true })
    }
  },

  // Live sidebar preview: replace the matching group's last_message with the one
  // from a group:preview socket event. Immutable map; leaves the list untouched
  // when the group isn't present (a group:added reload will bring it in).
  applyPreview: (groupId, last_message) =>
    set((s) => ({
      groups: s.groups.map((g) => (g.id === groupId ? { ...g, last_message } : g)),
    })),

  // Drop the current account's groups (call on sign-out so the next account
  // never sees the previous one's list before load() runs).
  reset: () => set({ groups: [], loaded: false }),

  // Create a real group via POST /api/groups (with the picked member ids; the
  // caller is added server-side), then refresh the list so previews and counts
  // come from the DB.
  addGroup: async (name, memberIds) => {
    const trimmed = name.trim()
    const group = await createGroup(trimmed, memberIds)
    await get().load()
    return group
  },

  // Invite a member by username (POST /api/groups/:id/members). Surfaces the
  // gateway's error codes as friendly messages; refreshes the list on success.
  inviteMember: async (groupId, username) => {
    const name = username.trim()
    if (!name) return { ok: false, error: 'Enter a username.' }
    try {
      await addGroupMember(groupId, { username: name })
      await get().load()
      return { ok: true }
    } catch (err) {
      const status = isAxiosError(err) ? err.response?.status : undefined
      if (status === 404) return { ok: false, error: 'No user found with that username.' }
      if (status === 409) return { ok: false, error: 'That user is already a member.' }
      if (status === 403) return { ok: false, error: "You're not a member of this group." }
      return { ok: false, error: 'Could not add member. Try again.' }
    }
  },

  // Leave a group: remove yourself server-side, then drop it from the list.
  leaveGroup: async (groupId, userId) => {
    await removeGroupMember(groupId, userId)
    await get().load()
  },
}))
