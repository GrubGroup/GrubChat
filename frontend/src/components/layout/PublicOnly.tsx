import { useEffect, useRef, useState } from 'react'
import { Outlet, useNavigate } from 'react-router'
import { AppSplash } from './AppSplash'
import { useSession } from '@/lib/authClient'
import { useAuthStore } from '@/stores/authStore'
import { useGroupsStore, mostRecentGroup } from '@/stores/groupsStore'
import { fetchProfile } from '@/api/profileApi'

// Wraps the public routes (/, /login, /signup) and forwards an already-authenticated
// visitor into the app. This is the path a Google OAuth return takes: the browser
// reloads fresh at the app origin, so nothing else knows where to send the user.
//
// Once the session resolves: no saved profile → onboarding (brand-new account —
// Google never reaches AuthForm.onAuthed); otherwise into the app, landing in the
// most recently active group, or /groups when they have none.
export function PublicOnly() {
  const navigate = useNavigate()
  const { data: session } = useSession()
  // When the interactive form has claimed the entry flow it routes itself (and
  // slides sign-up → onboarding inside AuthFlowShell). Standing down here keeps
  // this forward from racing it and keeps the splash off the slide.
  const entryFlowActive = useAuthStore((s) => s.entryFlowActive)

  // The ref guards the async fetch from firing more than once; `routed` is the
  // render-safe mirror used to stop showing the splash once the forward has
  // completed (so an authenticated user who navigates back to a public screen on
  // purpose isn't stuck behind it).
  const routedRef = useRef(false)
  const [forwarding, setForwarding] = useState(false)
  const [routed, setRouted] = useState(false)

  useEffect(() => {
    if (entryFlowActive) return
    if (!session?.user || routedRef.current) return
    routedRef.current = true
    setForwarding(true)
    void (async () => {
      try {
        const profile = await fetchProfile()
        if (!profile) {
          navigate('/onboarding', { replace: true })
          return
        }
        await useGroupsStore.getState().load()
        const latest = mostRecentGroup(useGroupsStore.getState().groups)
        navigate(latest ? `/groups/${latest.id}` : '/groups', { replace: true })
      } finally {
        setForwarding(false)
        setRouted(true)
      }
    })()
  }, [session, entryFlowActive, navigate])

  // Keep the branded loader up — never the landing page — while an authenticated
  // user is being forwarded into the app.
  if ((session?.user && !routed && !entryFlowActive) || forwarding) return <AppSplash />

  return <Outlet />
}
