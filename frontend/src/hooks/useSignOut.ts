import { useAuthStore } from '@/stores/authStore'
import { useGroupsStore } from '@/stores/groupsStore'
import { useNavStore } from '@/stores/navStore'
import { signOut } from '@/lib/authClient'

// Clear the Better Auth session (cookie) + local state, then return to sign-in.
// Resets the selected group to the sentinel so the next account never targets the
// previous one's room before its own load() runs.
//
// Shared by the desktop rail's AccountMenu and the Profile tab's mobile-only
// "Sign out" — two hosts, one flow, so they can't drift.
export function useSignOut(): () => Promise<void> {
  const logout = useAuthStore((s) => s.logout)
  const resetGroups = useGroupsStore((s) => s.reset)
  const go = useNavStore((s) => s.go)
  const setGroup = useNavStore((s) => s.setGroup)

  return async () => {
    await signOut()
    logout()
    resetGroups()
    setGroup(0)
    go('sign-in')
  }
}
