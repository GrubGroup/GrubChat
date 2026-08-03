import type { Restaurant } from '@/types'
import { Badge, Button, Icon, Modal } from '@/components/ui'
import { TagRow } from './TagRow'
import { RestaurantImage } from './RestaurantImage'
import { restaurantTint } from '@/constants/restaurantVisuals'
import { useIsMobile } from '@/hooks/useIsMobile'
import { formatHours, isOpenAt } from '@/utils/hours'
import { priceLevel } from '@/utils/price'

interface RestaurantDetailModalProps {
  restaurant: Restaurant | null
  open: boolean
  onClose: () => void
  liked: boolean
  /** A like/unlike request for this restaurant is in flight. */
  pending: boolean
  /** Snapshot of "now" for the open/closed verdict (shared with the page's filters). */
  now: Date
  onToggleLike: () => void
}

// Full-detail dialog for a restaurant, opened from an Explore card. The reusable
// Modal supplies the X button (via `title`), backdrop + Escape dismissal, focus
// trap, and scroll lock; we render the details in the body and a like CTA in the
// sticky footer.
//
// The Modal is ALWAYS rendered (never early-returned) so its useDismissOnBack hook
// first mounts with active=false — matching the app's other always-mounted modals.
// Mounting it while already open makes StrictMode's double-invoked mount effect
// pop an extra history entry (which navigated away from the page on backdrop close).
export function RestaurantDetailModal({
  restaurant,
  open,
  onClose,
  liked,
  pending,
  now,
  onToggleLike,
}: RestaurantDetailModalProps) {
  const isMobile = useIsMobile()

  const price = restaurant ? priceLevel(restaurant.price_avg) : ''
  const hours = restaurant ? formatHours(restaurant.hours) : null
  // isOpenAt treats unknown/unparseable hours as open, so only show the verdict
  // when we actually have an hours string.
  const openNow = restaurant && hours ? isOpenAt(restaurant.hours, now) : null

  return (
    <Modal
      open={open && !!restaurant}
      onClose={onClose}
      title={restaurant?.name ?? ''}
      size="lg"
      variant={isMobile ? 'sheet' : 'center'}
      footer={
        <Button
          fullWidth
          variant={liked ? 'primary' : 'accent'}
          disabled={pending}
          leftIcon={<Icon name="heart" size={16} filled={liked} />}
          onClick={onToggleLike}
        >
          {liked ? 'Liked' : 'Like this place'}
        </Button>
      }
    >
      {restaurant && (
        <div className="flex flex-col gap-4">
          {/* Cuisine photo — re-rolled each time the modal opens on a different
              restaurant, matching the card that launched it in spirit but not
              (deliberately) in the exact picture. */}
          <RestaurantImage
            cuisineTags={restaurant.cuisine_tags}
            identity={restaurant.id}
            className="h-40 w-full rounded-card sm:h-52"
            tintClass={restaurantTint(restaurant.id)}
          />

          {/* Rating · price · open status */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-body text-text-muted">
            {restaurant.avg_rating != null && (
              <span className="inline-flex items-center gap-1 font-semibold text-text">
                <Icon name="star" size={14} filled className="text-primary" />
                {restaurant.avg_rating.toFixed(1)}
              </span>
            )}
            {price && (
              <span>
                {price}
                {restaurant.price_avg != null ? ` · ~$${restaurant.price_avg}pp` : ''}
              </span>
            )}
            {openNow != null && (
              <Badge tone={openNow ? 'success' : 'neutral'}>{openNow ? 'Open now' : 'Closed'}</Badge>
            )}
          </div>

          {restaurant.description && (
            <p className="text-body text-text-muted">{restaurant.description}</p>
          )}

          {(restaurant.cuisine_tags.length > 0 || restaurant.dietary_tags.length > 0) && (
            <TagRow cuisineTags={restaurant.cuisine_tags} dietaryTags={restaurant.dietary_tags} />
          )}

          {restaurant.address && (
            <div className="flex flex-col gap-1">
              <p className="text-overline font-semibold uppercase tracking-wide text-text-muted">
                Address
              </p>
              <p className="flex items-center gap-1.5 text-body text-text">
                <Icon name="map-pin" size={14} className="text-text-muted" />
                {restaurant.address}
              </p>
            </div>
          )}

          {hours && (
            <div className="flex flex-col gap-1">
              <p className="text-overline font-semibold uppercase tracking-wide text-text-muted">
                Hours
              </p>
              <p className="text-body text-text">{hours}</p>
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}
