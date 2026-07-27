import { Navigate, Outlet } from 'react-router'
import { AppSplash } from './AppSplash'
import { useSession } from '@/lib/authClient'
import { useAuthStore } from '@/stores/authStore'

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

  if (session?.user || user) return <Outlet />
  if (isPending) return <AppSplash />

  return <Navigate to="/login" replace />
}
