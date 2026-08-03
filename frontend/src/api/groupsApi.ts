import type { Group, GroupDetail, Session } from '@/types'
import { api } from '@/lib/axios'

// The gateway returns groups the caller belongs to, each with its latest message
// (last_message) for the sidebar preview.
export async function fetchGroups(): Promise<Group[]> {
  const { data } = await api.get<Group[]>('/groups')
  return data
}

// Create a group. The gateway auto-adds the caller as the first member;
// member_ids (integer user ids) seed additional members at creation.
export async function createGroup(name: string, member_ids?: number[]): Promise<Group> {
  const { data } = await api.post<Group>('/groups', { name, ...(member_ids ? { member_ids } : {}) })
  return data
}

// Add a member to a group by username (the person shares their username) or by
// user_id. There is no user-search endpoint, so username entry is the real path.
export async function addGroupMember(
  groupId: number,
  who: { username: string } | { user_id: number },
): Promise<void> {
  await api.post(`/groups/${groupId}/members`, who)
}

// Remove a member from a group (or leave, when userId is the caller). Maps to
// DELETE /api/groups/:id/members/:user_id (204 on success).
export async function removeGroupMember(groupId: number, userId: number): Promise<void> {
  await api.delete(`/groups/${groupId}/members/${userId}`)
}

// Group detail with its member list (joined to User).
export async function fetchGroup(groupId: number): Promise<GroupDetail> {
  const { data } = await api.get<GroupDetail>(`/groups/${groupId}`)
  return { ...data, members: data.members ?? [] }
}

// The group's current OPEN session, or null when none is in progress. Used to
// rebind an in-progress session on page reload — the socket `session:start` was
// already missed and isn't replayed on join.
export async function fetchCurrentGroupSession(groupId: number): Promise<Session | null> {
  const { data } = await api.get<Session | null>(`/groups/${groupId}/sessions/current`)
  return data
}
