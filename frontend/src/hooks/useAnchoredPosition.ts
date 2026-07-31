import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

export interface AnchoredRect {
  top: number
  left: number
  width: number
  /** Space actually available on the chosen side, after the viewport margin. */
  maxHeight: number
}

/** Reproduces the `mt-1` (0.25rem) gap the absolute menu used to inherit. */
const GAP = 4
/** Keep the menu off the viewport edge. */
const EDGE = 8

interface Options {
  /** Re-measure when the menu's own height can change (async suggestions). */
  revision?: unknown
  /** Hard cap in px — reproduces `max-h-60` on the address menu. */
  maxHeight?: number
}

/**
 * Places a `position: fixed` menu against `anchorRef`'s border box.
 *
 * Why fixed-against-the-viewport rather than absolute: an absolutely positioned
 * menu joins the scrollable-overflow region of its nearest scroll-container
 * ancestor (per CSS Overflow 3, a scroller's overflow region includes the border
 * boxes of every descendant it is a containing-block ancestor for). Inside
 * Modal's body scroller that inflates scrollHeight by the menu's height while
 * clientHeight is unchanged — the dialog grows a scrollbar and clips the menu,
 * which is the reported bug. A fixed box's containing block is the viewport, so
 * it contributes nothing to any scroller.
 *
 * Pair this with a portal to <body>. The dialog panel carries a real CSS
 * transform for the 0.22s enter/exit (Modal.tsx), and a transformed element IS a
 * containing block and clipping context for fixed descendants — so a fixed menu
 * left inside the panel would jump and clip while the dialog animates. Portaling
 * makes the timing question moot.
 */
export function useAnchoredPosition<T extends HTMLElement>(
  anchorRef: RefObject<HTMLElement | null>,
  open: boolean,
  onDismiss: () => void,
  { revision, maxHeight }: Options = {},
) {
  const menuRef = useRef<T | null>(null)
  const [rect, setRect] = useState<AnchoredRect | null>(null)

  // Keep the dismiss callback in a ref so the listener effect below has a stable
  // dependency list — StrictMode double-invokes effects in dev, and add/remove
  // must stay symmetric.
  const dismissRef = useRef(onDismiss)
  useEffect(() => {
    dismissRef.current = onDismiss
  }, [onDismiss])

  const measure = useCallback(() => {
    const anchor = anchorRef.current
    const menu = menuRef.current
    if (!anchor || !menu) return
    const r = anchor.getBoundingClientRect()
    // scrollHeight, not offsetHeight: on the first layout pass the node is still
    // unpositioned and we want its NATURAL height to decide the flip.
    const natural = menu.scrollHeight
    const height = maxHeight ? Math.min(natural, maxHeight) : natural
    const below = window.innerHeight - r.bottom - GAP - EDGE
    const above = r.top - GAP - EDGE
    const flip = height > below && above > below
    setRect({
      left: r.left,
      width: r.width,
      top: flip ? Math.max(EDGE, r.top - GAP - Math.min(height, above)) : r.bottom + GAP,
      maxHeight: Math.max(0, flip ? above : below),
    })
  }, [anchorRef, maxHeight])

  // useLayoutEffect, not useEffect: this runs before paint, so the two-pass
  // (render unpositioned -> measure -> reposition) never reaches the screen.
  //
  // The closed case is DERIVED at the return below rather than written here. A
  // `setRect(null)` on the early-return path is a synchronous state write inside
  // an effect — it schedules a second render on every close for a value the
  // caller never reads (the menu is unmounted), and the linter rejects it. The
  // stale rect it would have cleared can never paint either: on the next open
  // this effect measures before the browser paints, and React re-renders
  // synchronously from a layout effect.
  useLayoutEffect(() => {
    if (!open) return
    measure()
  }, [open, measure, revision])

  useLayoutEffect(() => {
    if (!open) return
    // capture: true is mandatory. The menu is anchored to a field inside Modal's
    // body scroller, and scroll events do not bubble — only a capture-phase
    // listener on window sees them. Closing (rather than repositioning) matches a
    // native <select> on desktop Chrome.
    const onScroll = () => dismissRef.current()
    const onResize = () => measure()
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    // visualViewport fires when the iOS software keyboard opens/closes, which
    // moves the anchor without firing a window resize.
    window.visualViewport?.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
      window.visualViewport?.removeEventListener('resize', onResize)
    }
  }, [open, measure])

  // `open ? rect : null` — see the measure effect above. A closed menu reports no
  // placement, so a caller that renders while closed can never read a stale one.
  return { menuRef, rect: open ? rect : null }
}
