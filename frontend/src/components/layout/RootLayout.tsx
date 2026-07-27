import { useEffect } from 'react'
import { Outlet } from 'react-router'
import { AppSplash } from './AppSplash'
import { useSession } from '@/lib/authClient'
import { useAuthStore } from '@/stores/authStore'
import type { SessionUser } from '@/stores/authStore'

// Top of the route tree: runs once for every route. Mirrors Better Auth's session
// (httpOnly cookie) into the auth store, so guards and pages read a single source
// of truth and survive a refresh.
//
// The splash gate covers the initial session check for EVERY route — including the
// public ones. That's deliberate: without it a signed-in user reloading would see
// the landing page flash before the session resolves and forwards them into the app.
// A logged-OUT user has no session, so they fall through to the landing page after
// the brief pending window.
export function RootLayout() {
  const setSessionUser = useAuthStore((s) => s.setSessionUser)
  const { data: session, isPending } = useSession()

  useEffect(() => {
    setSessionUser((session?.user as SessionUser | undefined) ?? null)
  }, [session, setSessionUser])

  if (isPending) return <AppSplash />

  return <Outlet />
}
