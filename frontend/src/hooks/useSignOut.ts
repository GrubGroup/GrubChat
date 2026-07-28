import { useNavigate } from 'react-router'
import { useAuthStore } from '@/stores/authStore'
import { useGroupsStore } from '@/stores/groupsStore'
import { useEventListStore } from '@/stores/eventListStore'
import { signOut } from '@/lib/authClient'

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
