import { AuthFlowShell } from '@/components/layout/AuthFlowShell'
import { LandingPage } from '@/pages/public/LandingPage'
import { EmptyGroupsPage } from '@/pages/member/EmptyGroupsPage'
import { GroupChatPage } from '@/pages/member/GroupChatPage'
import { EventsPage } from '@/pages/member/EventsPage'
import { AgentChatPage } from '@/pages/member/session/AgentChatPage'
import { TopPicksPage } from '@/pages/member/session/TopPicksPage'
import { ProfilePage } from '@/pages/member/ProfilePage'
import { ProfileEditPage } from '@/pages/member/ProfileEditPage'
import { useEffect, useRef, useState } from 'react'
import { AppSplash } from '@/components/layout/AppSplash'
import { useNavStore } from '@/stores/navStore'
import { useAuthStore } from '@/stores/authStore'
import { useGroupsStore, mostRecentGroup } from '@/stores/groupsStore'
import { useSession } from '@/lib/authClient'
import { useGroupSync } from '@/hooks/useGroupSync'
import { fetchProfile } from '@/api/profileApi'
import type { SessionUser } from '@/stores/authStore'

// Frontend-only screen switch (no router). Transitions follow the wireframe
// journey (see frontend-user-journey memory).
function App() {
  const screen = useNavStore((s) => s.screen)
  const go = useNavStore((s) => s.go)
  const setGroup = useNavStore((s) => s.setGroup)
  const user = useAuthStore((s) => s.user)
  const setSessionUser = useAuthStore((s) => s.setSessionUser)
  // When the interactive form has claimed the entry flow, App stands down its own
  // forward + splash so AuthFlowShell stays mounted and slides sign-up → onboarding.
  const entryFlowActive = useAuthStore((s) => s.entryFlowActive)

  // Mirror Better Auth's session (httpOnly cookie) into the store, so the guard
  // and pages read a single source of truth and survive refresh.
  const { data: session, isPending } = useSession()
  useEffect(() => {
    setSessionUser((session?.user as SessionUser | undefined) ?? null)
  }, [session, setSessionUser])

  // Keep the sidebar's group list live: refresh it when the gateway signals this
  // user was added to / removed from a group (no-op when signed out / in mock mode).
  useGroupSync()

  const isAuthScreen = screen === 'sign-in' || screen === 'sign-up'
  // Public screens a logged-out user may view without being bounced to sign-in.
  const isPublicScreen = isAuthScreen || screen === 'landing'

  // After Google OAuth the browser reloads fresh at the app origin with the nav
  // store defaulted to 'sign-in'. Once the session resolves, move an
  // authenticated user off the auth screens: to onboarding if they have no
  // profile yet (brand-new — Google never hits AuthForm.onAuthed); otherwise into
  // the app — an existing user with groups lands in their most recent group chat,
  // one with none sees empty-groups. The ref guards the async fetch from firing
  // more than once.
  const routedRef = useRef(false)
  // `forwarding`: the async forward (profile + groups fetch) is in flight — keep
  // the splash up so the landing page never shows behind it. `routed`: the
  // initial auth-forward has completed at least once; used (as render-safe state,
  // not the ref) to stop showing the splash if an authenticated user later
  // navigates back to a public screen on purpose.
  const [forwarding, setForwarding] = useState(false)
  const [routed, setRouted] = useState(false)
  useEffect(() => {
    // The interactive form owns routing (incl. the sign-up → onboarding slide) —
    // don't double-forward or flash the splash over it.
    if (entryFlowActive) return
    // Forward an authenticated user off any public screen (auth pages OR the
    // landing page, which is now the fresh-reload default) into the app.
    if (!session?.user || !isPublicScreen || routedRef.current) return
    routedRef.current = true
    setForwarding(true)
    void (async () => {
      try {
        const profile = await fetchProfile()
        if (!profile) {
          go('onboarding-1')
          return
        }
        await useGroupsStore.getState().load()
        const latest = mostRecentGroup(useGroupsStore.getState().groups)
        if (latest) {
          setGroup(latest.id)
          go('group-chat')
        } else {
          go('empty-groups')
        }
      } finally {
        setForwarding(false)
        setRouted(true)
      }
    })()
  }, [session, isPublicScreen, entryFlowActive, go, setGroup])

  // Splash gate: show a branded loader — never the landing page — while the
  // session check is pending, OR while an authenticated user on a public screen
  // is being forwarded into the app. This closes the "landing flash before auth
  // resolves" gap for a signed-in user reloading. A logged-OUT user has no
  // session.user, so they fall through to the landing page after the brief pending
  // window. Skip the "authed on a public screen" case while the interactive form
  // owns the entry flow — otherwise the splash would cover the sign-up →
  // onboarding slide (the form shows the splash itself only for the app-forward).
  if (
    isPending ||
    (session?.user && isPublicScreen && !routed && !entryFlowActive) ||
    forwarding
  ) {
    return <AppSplash />
  }

  // Auth guard: every screen except the public pages (landing + auth) requires a
  // signed-in user. Wait for the initial session check before bouncing.
  if (!isPending && !user && !isPublicScreen) {
    return <AuthFlowShell />
  }

  switch (screen) {
    case 'landing':
      return <LandingPage />
    // Sign-in / sign-up AND the four onboarding steps all render through ONE
    // persistent shell: the brand panel stays mounted and only the right content
    // cross-slides — so a new account slides from sign-up straight into onboarding.
    case 'sign-in':
    case 'sign-up':
    case 'onboarding-1':
    case 'onboarding-2':
    case 'onboarding-3':
    case 'onboarding-4':
      return <AuthFlowShell />
    case 'empty-groups':
      return <EmptyGroupsPage />
    // Group-chat context — the session card changes state per screen.
    case 'group-chat':
    case 'session-continue':
    case 'session-waiting':
    case 'scrolled-past':
    case 'session-complete':
      return <GroupChatPage />
    // Agent-chat context.
    case 'agent-chat':
    case 'voice':
    case 'agent-chat-done':
      return <AgentChatPage />
    case 'top-picks':
      return <TopPicksPage />
    case 'events':
      return <EventsPage />
    case 'profile':
      return <ProfilePage />
    case 'profile-edit':
      return <ProfileEditPage />
    default:
      return <AuthFlowShell />
  }
}

export default App
