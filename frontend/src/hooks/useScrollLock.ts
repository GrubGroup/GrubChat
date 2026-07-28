import { useEffect } from 'react'

// Ref-counted so nested surfaces (a sheet opened from inside the drawer) don't
// have the inner one's cleanup unlock the page while the outer is still up.
let locks = 0
let restore = ''

/*
 * Freezes page scroll behind an open overlay (modal, sheet, drawer). Matters far
 * more on mobile: without it, a swipe inside a sheet scroll-chains to the page
 * underneath, so the sheet appears to drift and the content behind it moves.
 */
export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return
    if (locks === 0) {
      restore = document.body.style.overflow
      document.body.style.overflow = 'hidden'
    }
    locks++
    return () => {
      locks--
      if (locks === 0) document.body.style.overflow = restore
    }
  }, [active])
}
