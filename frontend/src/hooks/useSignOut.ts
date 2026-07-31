import { useNavigate } from 'react-router'
import { useAuthStore } from '@/stores/authStore'
import { useGroupsStore } from '@/stores/groupsStore'
import { useEventListStore } from '@/stores/eventListStore'
import { signOut } from '@/lib/authClient'
import { deactivateAccount } from '@/api/userApi'

// Clear the Better Auth session (cookie) + local state, then return to sign-in.
// Dropping the group + event lists means the next account never sees the previous
// one's rooms before its own load() runs (the selected group now lives in the URL,
// and we're navigating away from it).
//
// Shared by the desktop rail's AccountMenu and the Profile tab's mobile-only
// "Sign out" — two hosts, one flow, so they can't drift.
export function useSignOut(): () => Promise<void> {
  const logout = useAuthStore((s) => s.logout)
  const resetGroups = useGroupsStore((s) => s.reset)
  const resetEvents = useEventListStore((s) => s.reset)
  const navigate = useNavigate()

  return async () => {
    await signOut()
    logout()
    resetGroups()
    resetEvents()
    navigate('/login')
  }
}

// Delete ("deactivate") the caller's account, then run the exact same teardown as
// sign-out. Order matters: the DELETE must succeed first (it can 409 while the
// caller hosts an open session — that error propagates so the modal can show it);
// only then do we sign out and clear local state. The server has already revoked
// the session, so the signOut() call may 401 — harmless, we clear state regardless.
export function useDeleteAccount(): () => Promise<void> {
  const logout = useAuthStore((s) => s.logout)
  const resetGroups = useGroupsStore((s) => s.reset)
  const resetEvents = useEventListStore((s) => s.reset)
  const navigate = useNavigate()

  return async () => {
    await deactivateAccount()
    await signOut().catch(() => {
      /* session already revoked server-side; clearing local state is enough */
    })
    logout()
    resetGroups()
    resetEvents()
    navigate('/login')
  }
}
