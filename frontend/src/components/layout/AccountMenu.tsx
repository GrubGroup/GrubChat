import { useEffect, useRef } from 'react'
import { Avatar, Icon } from '@/components/ui'
import type { IconName } from '@/components/ui'
import { cn } from '@/utils/cn'

// Account menu popover — opened by clicking the sidebar rail user avatar. Mirrors
// the "Account Menu (popover)" wireframe and its interaction-states frame:
//   - View profile (person), Account settings (gear → /settings),
//     Sign out (logout, destructive red)
//   - neutral hover #F0EEE9 / pressed #E5E4DF; sign-out red hover@8% / pressed@15%
//   - item radius 10, focus-visible accent ring
export interface AccountMenuProps {
  open: boolean
  onClose: () => void
  displayName: string
  username: string
  avatarUrl?: string | null
  /** Initials-fallback color token (memberColor(user.id)), so it matches the
   * user's chat/session avatar when they have no photo. */
  colorClass?: string
  onViewProfile: () => void
  onAccountSettings: () => void
  onSignOut: () => void
  /** Positioning classes for the popover; defaults to the full-width footer anchor. */
  positionClass?: string
}

export function AccountMenu({
  open,
  onClose,
  displayName,
  username,
  avatarUrl,
  colorClass,
  onViewProfile,
  onAccountSettings,
  onSignOut,
  positionClass = 'bottom-full left-3 right-3 mb-2',
}: AccountMenuProps) {
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Account menu"
      className={cn(
        'absolute z-50 overflow-hidden rounded-card border border-border bg-surface-raised p-1.5 shadow-xl',
        positionClass,
      )}
    >
      {/* Header: identity */}
      <div className="flex items-center gap-2.5 px-2.5 py-2">
        <Avatar name={displayName} src={avatarUrl} size="sm" colorClass={colorClass} />
        <div className="min-w-0">
          <p className="truncate text-body font-semibold text-text">{displayName}</p>
          <p className="truncate text-caption text-text-muted">@{username}</p>
        </div>
      </div>

      <div className="my-1 h-px bg-border" />

      <MenuItem
        icon="user"
        label="View profile"
        onClick={() => {
          onClose()
          onViewProfile()
        }}
      />
      <MenuItem
        icon="settings"
        label="Account settings"
        onClick={() => {
          onClose()
          onAccountSettings()
        }}
      />

      <div className="my-1 h-px bg-border" />

      <MenuItem
        icon="logout"
        label="Sign out"
        destructive
        onClick={() => {
          onClose()
          onSignOut()
        }}
      />
    </div>
  )
}

function MenuItem({
  icon,
  label,
  onClick,
  destructive = false,
  disabled = false,
}: {
  icon: IconName
  label: string
  onClick?: () => void
  destructive?: boolean
  disabled?: boolean
}) {
  return (
    <button
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left text-body font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring',
        disabled && 'cursor-not-allowed text-text-subtle',
        !disabled &&
          !destructive &&
          'text-text hover:bg-surface-sunken active:bg-border',
        !disabled &&
          destructive &&
          'text-error-text hover:bg-error/[0.08] active:bg-error/[0.15]',
      )}
    >
      <Icon name={icon} size={16} />
      {label}
    </button>
  )
}
