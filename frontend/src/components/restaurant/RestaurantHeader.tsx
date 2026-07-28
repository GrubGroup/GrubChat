import type { Restaurant } from '@/types'
import { Icon } from '@/components/ui'
import { TagRow } from './TagRow'

export interface RestaurantHeaderProps {
  restaurant: Restaurant
  matchScorePct?: number
}

export function RestaurantHeader({ restaurant, matchScorePct }: RestaurantHeaderProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-display font-bold text-text">{restaurant.name}</h2>
          <div className="mt-1 flex items-center gap-2 text-body text-text-muted">
            {restaurant.price_avg != null && <span>~${restaurant.price_avg}pp</span>}
            {restaurant.avg_rating != null && (
              <span className="flex items-center gap-0.5 text-primary">
                <Icon name="star" size={13} filled /> {restaurant.avg_rating}
              </span>
            )}
            {matchScorePct != null && <span className="text-primary">{matchScorePct}% match</span>}
          </div>
        </div>
      </div>
      {restaurant.description && (
        <p className="text-body text-text-muted">{restaurant.description}</p>
      )}
      <TagRow cuisineTags={restaurant.cuisine_tags} dietaryTags={restaurant.dietary_tags} />
      {restaurant.address && (
        <p className="flex items-center gap-1 text-body text-text-muted">
          <Icon name="map-pin" size={13} /> {restaurant.address}
        </p>
      )}
    </div>
  )
}
