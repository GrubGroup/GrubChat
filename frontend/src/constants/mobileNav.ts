import type { Screen } from '@/stores/navStore'

// Screens that show the mobile tab bar. Kept as DATA (not conditionals scattered
// through the pages) so it reads at a glance and converts to a route layout in
// one edit when routing lands. Absent from the chat screens — WhatsApp-style, a
// chat is a PUSHED screen whose back chevron returns to the `groups` list, and a
// tab bar there would sit under the mic/send row — and from the picks flow,
// which is a modal-style task the user finishes or backs out of.
export const SHOW_TAB_BAR: Screen[] = ['groups', 'events', 'profile']

// Height of the bar itself (the safe-area inset pads BELOW it). Pages that show
// the bar pad their scroll area by this much so content clears it: `pb-14`.
export const TAB_BAR_H = 'h-14'
