import { Navigate, Outlet } from 'react-router'
import { AppSplash } from './AppSplash'
import { useSession } from '@/lib/authClient'

// Auth guard for every non-public route. Gates on Better Auth's session directly
// rather than the mirrored authStore.user: RootLayout mirrors the session in an
// EFFECT, so on the first render after the session resolves the store is still
// null — reading it here would bounce a signed-in user to /login for one frame,
// and unlike the old inline fallback a redirect actually changes the URL.
//
// isPending is re-checked (RootLayout already gates on it) because useSession can
// refetch: a revalidation mid-navigation must not read as "signed out".
export function RequireAuth() {
  const { data: session, isPending } = useSession()

  if (isPending) return <AppSplash />
  if (!session?.user) return <Navigate to="/login" replace />

  return <Outlet />
}
