// Which routes show the mobile tab bar: the three tab ROOTS only. Kept here as a
// single matcher (not conditionals scattered through the pages) so it reads at a
// glance. Absent from the group chat — WhatsApp-style, a chat is a PUSHED screen
// whose back chevron returns to the `/groups` list, and a tab bar there would sit
// under the mic/send row — from the picks/session flow (a modal-style task the
// user finishes or backs out of), and from `/profile/edit` (a pushed screen).
export function showsTabBar(pathname: string): boolean {
  if (pathname === '/groups') return true
  if (pathname === '/explore') return true
  if (pathname === '/profile') return true
  // Events keeps the bar on its detail route too (the detail is a drawer over the
  // list, so the tab root is conceptually still in view).
  return pathname === '/events' || pathname.startsWith('/events/')
}

// Height of the bar itself (the safe-area inset pads BELOW it). Pages that show
// the bar pad their scroll area by this much so content clears it: `pb-14`.
export const TAB_BAR_H = 'h-14'
