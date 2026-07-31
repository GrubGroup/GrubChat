import { useEffect, useRef, useState } from 'react'
import { randomCuisineImage } from '@/constants/cuisineImages'

// Hold ONE random cuisine photo for as long as a thing is on screen.
//
// The pick itself is a coin flip (`randomCuisineImage`) — the product rule is
// "a new photo each time you preview this restaurant", never a stored id→photo
// map. Calling that during render would satisfy the letter of it and be awful in
// practice: every unrelated re-render (a vote arriving, a hover, a filter typing
// through) would swap the picture mid-look. So the roll happens once per mount
// and again only when `identity` changes — i.e. when the card is genuinely now
// showing a DIFFERENT restaurant, as happens when a list re-uses a row.
//
// `identity` is the restaurant id at nearly every call site. Passing something
// that changes on every render would re-roll on every render — the exact flicker
// this exists to prevent.
export function useCuisineImage(
  cuisineTags: readonly string[] | null | undefined,
  identity: string | number,
): string {
  // A stable primitive view of the tag list. Parents pass `restaurant.cuisine_tags`
  // straight through, and a store update hands down a fresh array with identical
  // contents — which must not read as a change. The joined string does.
  const tagsKey = (cuisineTags ?? []).filter(Boolean).join('|')

  const [src, setSrc] = useState(() => randomCuisineImage(cuisineTags))
  const rolledFor = useRef(identity)

  useEffect(() => {
    // The initial `useState` roll already covers the identity we mounted with.
    if (rolledFor.current === identity) return
    rolledFor.current = identity
    setSrc(randomCuisineImage(tagsKey ? tagsKey.split('|') : []))
  }, [identity, tagsKey])

  return src
}
