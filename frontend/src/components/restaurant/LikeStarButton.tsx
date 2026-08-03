import { Icon } from '@/components/ui'
import { cn } from '@/utils/cn'

interface LikeStarButtonProps {
  liked: boolean
  /** A like/unlike request is in flight — disables the control to block a double-tap. */
  pending?: boolean
  onToggle: () => void
  /** Accessible name (state-specific, e.g. "Like The Bird" / "Unlike The Bird"). */
  label: string
  size?: number
}

// The like toggle shared by the Explore cards and the "Liked places" list. A pill
// button (not IconButton, whose ghost variant is transparent) so the resting state
// is a visible sunken circle: liked = solid brand-orange with a white filled heart;
// unliked = sunken circle with a muted outline heart.
export function LikeStarButton({ liked, pending = false, onToggle, label, size = 18 }: LikeStarButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={liked}
      disabled={pending}
      onClick={(e) => {
        // Don't let a like bubble to a clickable parent (the Explore card opens a
        // detail modal on click); harmless where there is no parent handler.
        e.stopPropagation()
        onToggle()
      }}
      className={cn(
        'tap-target flex h-9 w-9 shrink-0 items-center justify-center rounded-pill transition-colors duration-150 ease-out',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring',
        'motion-safe:active:scale-[0.92] disabled:cursor-not-allowed disabled:opacity-50',
        liked
          ? 'bg-primary text-on-primary hover:bg-primary-hover'
          : 'bg-surface-sunken text-text-muted hover:text-text',
      )}
    >
      <Icon name="heart" size={size} filled={liked} />
    </button>
  )
}
