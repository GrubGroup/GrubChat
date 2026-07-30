import type { User } from '@/types'
import { api } from '@/lib/axios'

// The caller's own User account (identity fields shown on the profile header).
// Auth credentials (email/password) are owned by Better Auth and are NOT edited
// through here.

export interface UpdateUserInput {
  display_name?: string | null
  username?: string
}

// Thrown when the gateway rejects an update (e.g. 409 username taken). Carries
// the HTTP status so callers can branch on conflicts vs. other failures.
export class UserUpdateError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'UserUpdateError'
    this.status = status
  }
}

export async function updateMe(input: UpdateUserInput): Promise<User> {
  try {
    const { data } = await api.patch<User>('/user', input)
    return data
  } catch (err) {
    // Surface the gateway's { error } message + status (409 = username taken).
    const status = (err as { response?: { status?: number } })?.response?.status ?? 0
    const message =
      (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
      'Could not update your profile. Please try again.'
    throw new UserUpdateError(message, status)
  }
}

// "Delete" the caller's account (soft delete server-side: identity is scrubbed,
// sessions revoked, groups left, and any open session the caller hosts is handed
// off to another member or auto-closed — so this always succeeds barring a server
// error). Reuses UserUpdateError to keep one error shape across the /user
// endpoints, surfacing the gateway's { error } message on failure.
export async function deactivateAccount(): Promise<void> {
  try {
    await api.delete('/user')
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status ?? 0
    const message =
      (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
      'Could not delete your account. Please try again.'
    throw new UserUpdateError(message, status)
  }
}
