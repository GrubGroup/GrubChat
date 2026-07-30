import { useReducedMotion, type Variants } from 'framer-motion'

// Shared motion vocabulary for GrubChat's marketing + brand surfaces (landing
// page, auth/onboarding brand panel). Extracted here so those surfaces share one
// easing curve + entrance/float language instead of duplicating it.
//
// Reduced-motion: framer animates transforms via rAF, so the global
// `prefers-reduced-motion` CSS backstop in index.css (which only zeroes CSS
// transition/animation durations) does NOT suppress these. We must gate them in
// JS — hence the `make*`/`use*` reduce-aware variants below.

// Custom decelerate curve (easeOutExpo-ish) used by every entrance.
export const EASE = [0.22, 1, 0.36, 1] as const

// Scroll-into-view trigger: fire once, when 30% visible.
export const viewport = { once: true, amount: 0.3 } as const

// Reduced-motion-aware fade + rise on enter. `custom` (index) staggers siblings.
// When reduced, keep the fade but drop the rise + delays (no perceptible
// movement). Prefer `useFadeUp()` in components so it respects reduced motion.
export const makeFadeUp = (reduce: boolean): Variants => ({
  hidden: { opacity: 0, y: reduce ? 0 : 24 },
  show: (i = 0) => ({
    opacity: 1,
    y: 0,
    transition: { duration: reduce ? 0 : 0.55, delay: reduce ? 0 : i * 0.08, ease: EASE },
  }),
})

// Hook form — reads the OS reduced-motion setting and returns the right variants.
// Use this inside components for reduced-motion-aware fade + rise.
export const useFadeUp = (): Variants => makeFadeUp(!!useReducedMotion())

// Gentle infinite Y-oscillation for layered/floating panels. Returns an empty
// object when reduced (no idle loop). `delay`/`dist` desync cards for parallax.
export const makeFloat =
  (reduce: boolean) =>
  (delay: number, dist = 10) =>
    reduce
      ? {}
      : {
          animate: { y: [0, -dist, 0] },
          transition: { duration: 6, repeat: Infinity, ease: 'easeInOut', delay },
        }
