import type { ReactNode } from 'react'
import { useState } from 'react'
import { fallbackCuisineImage } from '@/constants/cuisineImages'
import { useCuisineImage } from '@/hooks/useCuisineImage'
import { cn } from '@/utils/cn'

interface RestaurantImageProps {
  /** The restaurant's `cuisine_tags` — decides which photo pools to draw from. */
  cuisineTags?: readonly string[] | null
  /** Re-rolls the photo when it changes; pass the restaurant id. */
  identity: string | number
  /** Sizing + shape for the frame (`h-28 w-full`, `h-12 w-12 rounded-xl`, …). */
  className?: string
  /** Tint shown under the photo — visible while it loads and if it never does. */
  tintClass?: string
  /** Overlays drawn on top of the photo (badges, gradient scrims, titles). */
  children?: ReactNode
}

// The photo "banner" behind a restaurant, wherever one appears: Explore cards and
// their detail modal, Top-picks rows and the results hero, Events rows and their
// hero. One component so the honesty rules below hold everywhere at once.
//
//   * DECORATIVE, so `alt=""` + `aria-hidden`. These are stock photos of the
//     CUISINE, not of the venue (the catalog has no image column) — announcing
//     one as "photo of Thai Basil Kitchen" would be a lie to a screen reader, and
//     the restaurant's name is always adjacent in the DOM anyway.
//   * The tint sits UNDER the photo rather than being replaced by it, so a card
//     looks deliberate for the moment before the JPEG decodes (and permanently,
//     if the network drops it) instead of flashing an empty box.
//   * A load failure falls back to a `default`-pool photo, exactly once. Both the
//     fallback and the "has it painted yet" flag are STORED AGAINST the pick they
//     belong to and compared by equality, so a re-roll (a re-used row now showing
//     a different restaurant) invalidates them for free.
export function RestaurantImage({
  cuisineTags,
  identity,
  className,
  tintClass,
  children,
}: RestaurantImageProps) {
  const picked = useCuisineImage(cuisineTags, identity)
  const [fallback, setFallback] = useState<{ replaces: string; src: string } | null>(null)
  const [paintedSrc, setPaintedSrc] = useState<string | null>(null)

  const shown = fallback?.replaces === picked ? fallback.src : picked
  const loaded = paintedSrc === shown

  return (
    <div className={cn('relative overflow-hidden', tintClass, className)}>
      <img
        src={shown}
        alt=""
        aria-hidden
        loading="lazy"
        decoding="async"
        onLoad={() => setPaintedSrc(shown)}
        onError={() => {
          // Keyed on the PICK, not on `shown`: the fallback roll can legitimately
          // land on the same url (when the pick was already a `default`-pool
          // photo), and a url-equality guard would then let the handler re-fire
          // forever. One fallback attempt per pick, full stop.
          if (fallback?.replaces === picked) return
          setFallback({ replaces: picked, src: fallbackCuisineImage() })
        }}
        className={cn(
          'absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ease-out',
          loaded ? 'opacity-100' : 'opacity-0',
        )}
      />
      {children}
    </div>
  )
}
