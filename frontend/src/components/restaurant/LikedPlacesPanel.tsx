import type { Restaurant } from '@/types'
import { Icon } from '@/components/ui'
import { LikeStarButton } from './LikeStarButton'
import { RestaurantImage } from './RestaurantImage'
import { restaurantTint } from '@/constants/restaurantVisuals'

interface LikedPlacesPanelProps {
  liked: Restaurant[]
  /** Restaurant ids with a like/unlike request in flight. */
  pending: Set<number>
  onToggleLike: (id: number) => void
}

// The "Liked places" list — the AppSidebar panel body on desktop and a section
// above the grid on mobile. Each row: cuisine-photo tile + name + "You liked
// this", with a trailing star to unlike. A footer note explains the payoff (only
// when non-empty, so the empty state reads cleanly).
export function LikedPlacesPanel({ liked, pending, onToggleLike }: LikedPlacesPanelProps) {
  return (
    <div className="flex flex-col">
      <p className="px-4 pb-1 pt-4 text-overline font-semibold uppercase tracking-wide text-text-muted">
        Liked places
      </p>

      {liked.length === 0 ? (
        <p className="px-4 py-6 text-body text-text-muted">
          No liked places yet. Tap ♥ on a card to save it.
        </p>
      ) : (
        <>
          {liked.map((r) => (
            <div key={r.id} className="flex items-center gap-3 px-4 py-3">
              <RestaurantImage
                cuisineTags={r.cuisine_tags}
                identity={r.id}
                className="h-10 w-10 shrink-0 rounded-2xl border border-border"
                tintClass={restaurantTint(r.id)}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-item-title font-semibold text-text">{r.name}</p>
                <p className="flex items-center gap-1 text-caption text-primary">
                  <Icon name="heart" size={11} filled /> You liked this
                </p>
              </div>
              <LikeStarButton
                liked
                pending={pending.has(r.id)}
                onToggle={() => onToggleLike(r.id)}
                label={`Unlike ${r.name}`}
                size={16}
              />
            </div>
          ))}
          <p className="mt-1 border-t border-border px-4 py-3 text-caption text-text-muted">
            Your agent factors these into every group pick.
          </p>
        </>
      )}
    </div>
  )
}
