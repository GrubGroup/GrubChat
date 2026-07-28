import { cn } from '@/utils/cn'

type AvatarSize = 'sm' | 'md' | 'lg'
type AvatarStatus = 'active' | 'done' | 'idle'

export interface AvatarProps {
  name: string
  src?: string | null
  size?: AvatarSize
  status?: AvatarStatus
  /** Tailwind color suffix for the initials background, e.g. "member-purple". */
  colorClass?: string
  className?: string
}

const sizeClasses: Record<AvatarSize, string> = {
  sm: 'h-8 w-8 text-caption',
  md: 'h-10 w-10 text-body',
  lg: 'h-14 w-14 text-section-title',
}

const statusRing: Record<AvatarStatus, string> = {
  active: 'ring-2 ring-primary',
  done: 'ring-2 ring-success',
  idle: 'ring-2 ring-border',
}

// Literal class map — Tailwind's scanner only sees classes written in full,
// so dynamic `bg-${x}` won't generate. Keep these spelled out.
const colorClasses: Record<string, string> = {
  'member-purple': 'bg-member-purple',
  'member-pink': 'bg-member-pink',
  'member-terracotta': 'bg-member-terracotta',
  'member-green': 'bg-member-green',
  'member-blue': 'bg-member-blue',
  'member-amber': 'bg-member-amber',
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export function Avatar({ name, src, size = 'md', status, colorClass, className }: AvatarProps) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-pill',
        'font-semibold text-white',
        colorClass ? colorClasses[colorClass] : 'bg-secondary',
        sizeClasses[size],
        status && statusRing[status],
        className,
      )}
    >
      {src ? (
        <img src={src} alt={name} className="h-full w-full object-cover" />
      ) : (
        <span aria-hidden="true">{initials(name)}</span>
      )}
    </span>
  )
}
