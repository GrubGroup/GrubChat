import type { ReactNode } from 'react'
import type { Restaurant } from '@/types'
import { Badge, Card, Icon } from '@/components/ui'
import { LikeStarButton } from './LikeStarButton'
import { RestaurantImage } from './RestaurantImage'
import { DIETARY_RESTRICTIONS, labelFor } from '@/constants/dietary'
import { POPULAR_MIN, restaurantTint } from '@/constants/restaurantVisuals'
import { formatDistanceMi } from '@/utils/distance'
import { priceLevel } from '@/utils/price'
import { cn } from '@/utils/cn'

interface RestaurantExploreCardProps {
  restaurant: Restaurant
  liked: boolean
  /** A like/unlike request for this restaurant is in flight. */
  pending: boolean
  /** Miles from the user's home location, when known (else distance is hidden). */
  distanceMi?: number
  onToggleLike: () => void
  /** Open the restaurant's detail modal (fired on card click / Enter / Space). */
  onOpen: () => void
}

// A browse card in the Explore grid: a soft deterministic tint banner with a state
// overlay badge (Liked / Popular), name, agent-context helper line, a
// rating · distance · price meta row, the first dietary tag, and the star toggle.
// Clicking the card (anywhere but the star) opens the detail modal.
export function RestaurantExploreCard({
  restaurant: r,
  liked,
  pending,
  distanceMi,
  onToggleLike,
  onOpen,
}: RestaurantExploreCardProps) {
  const rating = r.avg_rating
  // "Popular" is derived from rating (there is no popularity/review field); only for
  // places the viewer hasn't liked, so the liked badge always wins.
  const popular = !liked && rating != null && rating >= POPULAR_MIN
  const price = priceLevel(r.price_avg)
  const dietary = r.dietary_tags?.[0]

  // Rating · distance · price, interleaved with "·" separators so a missing piece
  // never leaves a dangling dot.
  const meta: ReactNode[] = []
  if (rating != null) {
    meta.push(
      <span key="rating" className="inline-flex items-center gap-1 font-semibold text-text">
        <Icon name="star" size={11} filled className="text-primary" />
        {rating.toFixed(1)}
      </span>,
    )
  }
  if (distanceMi != null) meta.push(<span key="dist">{formatDistanceMi(distanceMi)}</span>)
  if (price) meta.push(<span key="price">{price}</span>)

  return (
    <Card
      padding="none"
      role="button"
      tabIndex={0}
      aria-label={`View ${r.name} details`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
      className="overflow-hidden cursor-pointer transition-[translate,box-shadow] duration-150 ease-out hover:delay-150 hover:shadow-md motion-safe:hover:-translate-y-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
    >
      {/* Banner — a cuisine photo picked at random for this viewing, with the
          state badge overlaid. The deterministic tint stays as the backdrop under
          it so the card still reads while the image decodes. */}
      <RestaurantImage
        cuisineTags={r.cuisine_tags}
        identity={r.id}
        className="h-28 w-full"
        tintClass={restaurantTint(r.id)}
      >
        {liked ? (
          <span className="absolute left-3 top-3 inline-flex items-center gap-1 rounded-pill bg-primary px-2.5 py-0.5 text-caption font-semibold text-on-primary">
            <Icon name="star" size={11} filled /> Liked
          </span>
        ) : popular ? (
          <span className="absolute left-3 top-3 inline-flex items-center rounded-pill bg-surface-inverse px-2.5 py-0.5 text-caption font-semibold text-white">
            Popular
          </span>
        ) : null}
      </RestaurantImage>

      {/* Body */}
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate font-display text-item-title font-semibold text-text">{r.name}</h3>
            <p className={cn('mt-0.5 text-caption', liked ? 'text-primary' : 'text-text-muted')}>
              {liked ? 'Your agent factors this into picks' : 'Tap ★ to like — feeds your picks'}
            </p>
          </div>
          <LikeStarButton
            liked={liked}
            pending={pending}
            onToggle={onToggleLike}
            label={liked ? `Unlike ${r.name}` : `Like ${r.name}`}
          />
        </div>

        {meta.length > 0 && (
          <div className="mt-3 flex items-center gap-1.5 text-caption text-text-muted">
            {meta.map((node, i) => (
              <span key={i} className="inline-flex items-center gap-1.5">
                {i > 0 && (
                  <span aria-hidden className="text-text-subtle">
                    ·
                  </span>
                )}
                {node}
              </span>
            ))}
          </div>
        )}

        {dietary && (
          <div className="mt-3">
            <Badge tone="success">{labelFor(DIETARY_RESTRICTIONS, dietary)}</Badge>
          </div>
        )}
      </div>
    </Card>
  )
}
