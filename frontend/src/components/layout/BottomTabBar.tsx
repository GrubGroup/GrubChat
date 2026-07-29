import { useLocation, useNavigate } from 'react-router'
import { Icon, type IconName } from '@/components/ui'
import { showsTabBar, TAB_BAR_H } from '@/constants/mobileNav'
import { cn } from '@/utils/cn'

type Tab = {
  icon: IconName
  label: string
  /** Route this tab navigates to and the path prefix that lights it up. */
  to: string
}

const TABS: Tab[] = [
  { to: '/groups', icon: 'users', label: 'Groups' },
  { to: '/events', icon: 'calendar', label: 'Events' },
  { to: '/profile', icon: 'user', label: 'Profile' },
]

// Reserves the space the fixed tab bar covers at the END of a scroll area, so the
// last row is never trapped underneath it. Height plus a home-indicator margin —
// `h-14` alone would leave the safe-area strip overlapping (the bar itself pads
// into it). Margin, not padding, because border-box would absorb the padding.
export function TabBarSpacer() {
  return <div aria-hidden className="mb-safe-b h-14 shrink-0 md:hidden" />
}

// The mobile root navigation: Groups · Events · Profile. Fixed to the bottom,
// hidden at ≥md where the AppSidebar rail does this job. Active tab = filled icon
// + cocoa text, matching the rail's outline↔filled treatment.
export function BottomTabBar() {
  const { pathname } = useLocation()
  const navigate = useNavigate()

  // Self-gates on the route rather than trusting each caller, so a page that
  // renders the bar on a route it doesn't belong on (or a navigation under a
  // mounted page) can't surface it over a composer. Groups lands on the LIST,
  // never on a chat — WhatsApp-style, the chat is a level deeper reached by
  // tapping a row, so tapping the tab from inside a chat is the same "up" move as
  // the header's back chevron.
  if (!showsTabBar(pathname)) return null

  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface-raised pb-safe-b md:hidden"
    >
      <div className={cn('flex items-stretch', TAB_BAR_H)}>
        {TABS.map((tab) => {
          const active = pathname === tab.to || pathname.startsWith(`${tab.to}/`)
          return (
            <button
              key={tab.to}
              onClick={() => navigate(tab.to)}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex flex-1 flex-col items-center justify-center gap-0.5',
                active ? 'text-text' : 'text-text-muted',
              )}
            >
              {/* Outline + filled crossfaded via opacity — same approach as the
                  desktop rail's RailButton, so both stay visually consistent. */}
              <span className="relative inline-flex h-6 w-6">
                <Icon
                  name={tab.icon}
                  size={24}
                  className={cn(
                    'absolute inset-0 transition-opacity duration-150 ease-out',
                    active ? 'opacity-0' : 'opacity-100',
                  )}
                />
                <Icon
                  name={tab.icon}
                  size={24}
                  filled
                  className={cn(
                    'absolute inset-0 transition-opacity duration-150 ease-out',
                    active ? 'opacity-100' : 'opacity-0',
                  )}
                />
              </span>
              <span className={cn('text-caption', active ? 'font-semibold' : 'font-medium')}>
                {tab.label}
              </span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}
