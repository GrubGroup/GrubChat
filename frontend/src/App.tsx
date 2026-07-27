import { Navigate, Route, Routes } from 'react-router'
import { RootLayout } from '@/components/layout/RootLayout'
import { RequireAuth } from '@/components/layout/RequireAuth'
import { PublicOnly } from '@/components/layout/PublicOnly'
import { AuthFlowShell } from '@/components/layout/AuthFlowShell'
import { LandingPage } from '@/pages/public/LandingPage'
import { AuthForm } from '@/pages/auth/AuthForm'
import { DietaryStep } from '@/pages/member/onboarding/Onboarding1'
import { CuisinesStep } from '@/pages/member/onboarding/OnboardingCuisines'
import { BudgetStep } from '@/pages/member/onboarding/Onboarding2'
import { LocationStep } from '@/pages/member/onboarding/Onboarding3'
import { GroupsIndex } from '@/pages/member/GroupsIndex'
import { GroupChatPage } from '@/pages/member/GroupChatPage'
import { EventsPage } from '@/pages/member/EventsPage'
import { AgentChatPage } from '@/pages/member/session/AgentChatPage'
import { TopPicksPage } from '@/pages/member/session/TopPicksPage'
import { ProfilePage } from '@/pages/member/ProfilePage'
import { ProfileEditPage } from '@/pages/member/ProfileEditPage'

// The app's route tree. Three layout routes carry what used to be tangled together
// in one component:
//   RootLayout  — mirrors the Better Auth session into the store; splash while pending
//   PublicOnly  — forwards an already-authenticated visitor off the public pages
//   RequireAuth — bounces a signed-out visitor to /login
//
// AuthFlowShell is a layout route too, but for presentation: it keeps the brand panel
// mounted across sign-in / sign-up / onboarding so the right pane can cross-slide.
function App() {
  return (
    <Routes>
      <Route element={<RootLayout />}>
        {/* Public — the marketing page and the credential forms. */}
        <Route element={<PublicOnly />}>
          <Route index element={<LandingPage />} />
          <Route element={<AuthFlowShell />}>
            <Route path="login" element={<AuthForm mode="signin" />} />
            <Route path="signup" element={<AuthForm mode="signup" />} />
          </Route>
        </Route>

        {/* Everything below requires a session. */}
        <Route element={<RequireAuth />}>
          {/* Onboarding shares the shell with the credential forms, so a brand-new
              account slides from sign-up straight into step 1. /onboarding is the
              entry point; the step paths stay addressable for Back/Continue. */}
          <Route element={<AuthFlowShell />}>
            <Route path="onboarding" element={<Navigate to="/onboarding/dietary" replace />} />
            <Route path="onboarding/dietary" element={<DietaryStep />} />
            <Route path="onboarding/cuisines" element={<CuisinesStep />} />
            <Route path="onboarding/budget" element={<BudgetStep />} />
            <Route path="onboarding/location" element={<LocationStep />} />
          </Route>

          <Route path="groups">
            <Route index element={<GroupsIndex />} />
            <Route path=":groupId" element={<GroupChatPage />} />
            <Route path=":groupId/session/:sessionId" element={<AgentChatPage />} />
            <Route path=":groupId/session/:sessionId/done" element={<AgentChatPage done />} />
            <Route path=":groupId/session/:sessionId/picks" element={<TopPicksPage />} />
          </Route>

          <Route path="events">
            <Route index element={<EventsPage />} />
            <Route path=":eventId" element={<EventsPage />} />
          </Route>

          <Route path="profile">
            <Route index element={<ProfilePage />} />
            <Route path="edit" element={<ProfileEditPage />} />
          </Route>
        </Route>

        {/* Unknown path — send them home rather than rendering a blank screen. */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}

export default App
