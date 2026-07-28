import { create } from 'zustand'

// Screen switcher (no router) — mirrors the wireframe journey. See the
// frontend-user-journey memory for the transition map. Two parallel contexts:
// the group-chat view and the agent-chat view; a session shows as a card inside
// the group chat.
export type Screen =
  // Public
  | 'landing' // marketing landing page (logged-out entry)
  // Auth
  | 'sign-in'
  | 'sign-up'
  // Onboarding (profile/preferences): 1 dietary → 2 cuisines (like/avoid) →
  // 3 budget → 4 location
  | 'onboarding-1'
  | 'onboarding-2'
  | 'onboarding-3'
  | 'onboarding-4'
  // Group-chat context
  | 'groups' // the groups home: list of your groups (mobile root) / zero-state
  | 'group-chat' // Group Food Planning App (session card: not joined)
  | 'session-continue' // group-chat card, session in progress (after back)
  | 'session-waiting' // group-chat card, user done, waiting for others
  | 'scrolled-past' // floating session card when scrolled past
  // Agent-chat context
  | 'agent-chat'
  | 'voice'
  | 'agent-chat-done'
  // Results
  | 'session-complete'
  | 'top-picks'
  | 'events'
  // Profile
  | 'profile'
  | 'profile-edit'

interface NavState {
  screen: Screen
  groupId: number // currently-selected group (chat room)
  // Where the profile was opened from, so its Back returns to origin (the
  // account menu opens from many screens). Stamped by openProfile.
  returnTo: Screen
  go: (screen: Screen) => void
  // Open the profile view, remembering the current screen as the return target.
  openProfile: () => void
  setGroup: (id: number) => void
}

export const useNavStore = create<NavState>((set, get) => ({
  screen: 'landing',
  // Mock mode keeps 7 (the seeded demo "Work Lunch Crew" session/messages). Live
  // mode starts at 0 — a no-group sentinel (real ids are positive) — so a
  // brand-new user is never shown a group they haven't joined; GroupChatPage
  // redirects to the groups list until a real group is selected.
  groupId: 0,
  returnTo: 'group-chat',
  go: (screen) => set({ screen }),
  openProfile: () => set({ returnTo: get().screen, screen: 'profile' }),
  setGroup: (id) => set({ groupId: id }),
}))
