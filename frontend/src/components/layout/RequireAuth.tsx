import { useEffect } from 'react'
import { Navigate, Outlet } from 'react-router'
import { AppSplash } from './AppSplash'
import { useSession } from '@/lib/authClient'
import { useAuthStore } from '@/stores/authStore'
import { useGroupsStore } from '@/stores/groupsStore'
import { useGroupSync } from '@/hooks/useGroupSync'
import { useSessionSync } from '@/hooks/useSessionSync'

// Auth guard for every non-public route.
//
// EITHER signal is valid evidence of an authenticated user, because which one
// arrives first depends on how the user got here:
//   - reload / OAuth return → useSession() resolves first; RootLayout mirrors it
//     into authStore an effect later.
//   - interactive sign-in / sign-up → AuthForm sets authStore SYNCHRONOUSLY from the
//     auth response, then navigates immediately; useSession()'s refetch lands a beat
//     later.
// So requiring only useSession() bounces a just-created account to /login before its
// refetch completes — and PublicOnly deliberately stands down during the entry flow
// (entryFlowActive), so nothing forwards them back and they're stranded on the form.
// Requiring only authStore has the mirror-image gap on reload. Accept both.
//
// Checking "authenticated" BEFORE isPending also means a background revalidation
// never flashes the splash over a page the user is already on.
export function RequireAuth() {
  const { data: session, isPending } = useSession()
  const user = useAuthStore((s) => s.user)
  const groupsLoaded = useGroupsStore((s) => s.loaded)
  const loadGroups = useGroupsStore((s) => s.load)

  const authed = !!(session?.user || user)

  // Load the group list here, for every member route, because it is app-level data
  // that pages GATE THEMSELVES ON: GroupChatPage resolves membership from it before
  // it will render anything. Loading it from a page (or worse, from a component that
  // page only renders once it's already satisfied) deadlocks a cold URL entry — the
  // page renders nothing, so the loader never mounts, so the list never arrives.
  //
  // Runs even while a child renders null, since effects don't depend on what was
  // painted. Guarded on `loaded`, which groupsStore.load() sets on BOTH success and
  // failure, so a failing fetch can't spin.
  useEffect(() => {
    if (authed && !groupsLoaded) void loadGroups()
  }, [authed, groupsLoaded, loadGroups])

  // App-level socket listeners live here for the same reason the group list does:
  // they must outlive any single page. This layout route stays mounted across every
  // navigation inside the guard, so the subscriptions survive moving between the
  // group chat, the agent chat and the results screen — which is exactly when their
  // events arrive. Both no-op while signed out and in mock mode.
  //
  // Keep the sidebar's group list live: refresh it when the gateway signals this
  // user was added to / removed from a group.
  useGroupSync()
  // Adopt session picks live on any screen (chat or results) so force-finish /
  // auto-complete results appear without a wait or reload.
  useSessionSync()

  if (authed) return <Outlet />
  if (isPending) return <AppSplash />

  return <Navigate to="/login" replace />
}
