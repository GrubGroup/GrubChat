import type { ReactNode } from 'react'
import { useState } from 'react'
import { NavLink, useNavigate } from 'react-router'
import { Avatar, BrandMark, Icon, Wordmark, type IconName } from '@/components/ui'
import { AccountMenu } from './AccountMenu'
import { useAuthStore } from '@/stores/authStore'
import { useSignOut } from '@/hooks/useSignOut'
import { memberColor } from '@/constants/memberColors'
import { cn } from '@/utils/cn'

// Shared height for the top row of EVERY column (sidebar panel header, chat
// header, right panel header) so their bottom borders line up seamlessly.
export const COLUMN_HEADER_H = 'h-[61px]'

export interface AppSidebarProps {
  /** Small uppercase eyebrow under the constant "GrubChat" wordmark (e.g. "Groups", "Events"). */
  eyebrow?: string
  /** Optional action rendered on the right of the panel header (e.g. add button). */
  headerAction?: ReactNode
  /** Scrollable panel body — group list, events list, or an empty-state block. */
  children: ReactNode
  /** Show the current-user avatar + account menu on the rail. */
  showFooter?: boolean
  /** Hide the whole column below `md`, where the mobile chrome (BottomTabBar /
   * MobileDrawer / MobileHeader) navigates instead. On by default — pass `false`
   * only if a screen genuinely needs the rail at phone width. */
  responsive?: boolean
  /** Panel width utility (default 'w-56'). The group-chat list passes a wider
   * value so its chats have more breathing room. */
  panelWidth?: string
}

// The single left column used across group chat, agent chat, events, and the
// empty state. An icon rail (brand + section tabs + user avatar) plus a titled
// panel with a body slot. Rail tabs switch between the groups and events
// contexts; behavior mirrors the previous tab bar.
export function AppSidebar({
  eyebrow,
  headerAction,
  children,
  showFooter = true,
  responsive = true,
  panelWidth = 'w-56',
}: AppSidebarProps) {
  const user = useAuthStore((s) => s.user)
  const navigate = useNavigate()
  // Shared with ProfilePage's mobile sign-out (resets the group + event lists),
  // so the two can't drift.
  const handleSignOut = useSignOut()
  const [menuOpen, setMenuOpen] = useState(false)

  const displayName = user?.display_name ?? user?.username ?? 'You'
  // Deterministic initials color from the user id — the SAME source chat/session
  // avatars use — so a photoless user's color matches everywhere (was hardcoded
  // member-purple, which didn't match their chat color).
  const avatarColor = memberColor(user?.id ?? -1)

  return (
    <aside
      className={cn(
        'shrink-0 border-r border-border',
        responsive ? 'hidden md:flex' : 'flex',
      )}
    >
      {/* Icon rail */}
      <div className="flex w-16 flex-col items-center gap-1.5 border-r border-border bg-surface-sunken px-3 pb-4 pt-4">
        {/* Brand badge — the chat-bubble mark stands in for the wordmark on the rail. */}
        <BrandMark size={34} className="text-text" />


        <div className="mt-2 flex flex-col items-center gap-1.5">
          <RailTab icon="users" label="Groups" to="/groups" />
          <RailTab icon="calendar" label="Events" to="/events" />
          <RailTab icon="search" label="Explore" to="/explore" />
        </div>

        {/* Spacer pushes the user avatar to the bottom */}
        <div className="flex-1" />

        {showFooter && (
          <div className="relative">
            <AccountMenu
              open={menuOpen}
              onClose={() => setMenuOpen(false)}
              displayName={displayName}
              username={user?.username ?? 'you'}
              avatarUrl={user?.avatar_url}
              colorClass={avatarColor}
              onViewProfile={() => navigate('/profile')}
              onAccountSettings={() => navigate('/settings')}
              onSignOut={handleSignOut}
              // Opens beside the rail avatar (bottom-aligned to the right).
              positionClass="bottom-0 left-full ml-2 w-56"
            />
            <button
              onClick={() => setMenuOpen((o) => !o)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="Account menu"
              className="rounded-pill focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <Avatar name={displayName} src={user?.avatar_url} size="md" colorClass={avatarColor} />
            </button>
          </div>
        )}
      </div>

      {/* Panel */}
      <div className={cn('flex flex-col bg-surface-panel', panelWidth)}>
        {/* Panel header — same height as every column header */}
        <div
          className={cn(
            'flex items-center justify-between gap-2 border-b border-border pl-4 pr-3.5',
            COLUMN_HEADER_H,
          )}
        >
          <div className="flex min-w-0 flex-1 flex-col justify-center">
            <Wordmark size="sm" showTile={false} />
            {eyebrow && (
              <p className="mt-0.5 truncate text-overline font-semibold uppercase tracking-wide text-text-muted">
                {eyebrow}
              </p>
            )}
          </div>
          {headerAction}
        </div>

        {/* Body */}
        <div className="flex flex-1 flex-col overflow-y-auto">{children}</div>
      </div>
    </aside>
  )
}

// A rail tab is a NavLink, so "active" comes from the URL rather than a prop each
// page has to remember to pass. Non-`end` matching means the Groups tab stays lit
// across every /groups/* sub-route — a group chat, a session, the picks screen —
// which the old hardcoded activeTab could not express.
function RailTab({ icon, label, to }: { icon: IconName; label: string; to: string }) {
  return (
    <NavLink
      to={to}
      title={label}
      aria-label={label}
      className={({ isActive }) =>
        cn(
          // tap-target: the tile stays 40px; only the hit area reaches 44px, which
          // matters on touch tablets at ≥md where this rail is still shown.
          'group tap-target relative flex h-10 w-10 items-center justify-center rounded-xl transition-colors',
          isActive
            ? 'bg-surface-inverse text-white'
            : 'text-text-muted hover:bg-surface-raised/70 hover:text-text',
        )
      }
    >
      {({ isActive }) => (
        // Outline (default) + filled (active or hovered) crossfaded via opacity —
        // pure CSS group-hover, no re-render. Under reduced motion the CSS
        // backstop zeroes the fade so it swaps instantly.
        <span className="relative inline-flex h-[18px] w-[18px]">
          <Icon
            name={icon}
            size={18}
            className={cn(
              'absolute inset-0 transition-opacity duration-150 ease-out',
              isActive ? 'opacity-0' : 'opacity-100 group-hover:opacity-0',
            )}
          />
          <Icon
            name={icon}
            size={18}
            filled
            className={cn(
              'absolute inset-0 transition-opacity duration-150 ease-out',
              isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
            )}
          />
        </span>
      )}
    </NavLink>
  )
}
