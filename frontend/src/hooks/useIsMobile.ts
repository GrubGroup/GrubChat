import { useMediaQuery } from './useMediaQuery'

// The one desktop/mobile line for the whole app, matching Tailwind's `md`. Keep it
// here so the JS breakpoint can never drift from the `md:` classes doing the
// layout work in CSS.
export const MD_QUERY = '(min-width: 768px)'

/*
 * Whether we're below `md`. Use this ONLY where BEHAVIOUR differs — does ⋯ open a
 * sheet or an inline panel, does a row drill down or select in place. Layout is
 * done with `md:` classes, never by branching here: rendering two trees would
 * double-mount the chat's socket subscriptions and lose scroll position.
 *
 * `useMediaQuery`'s first snapshot is `false`, so MD_QUERY resolves "not desktop"
 * on the very first paint — i.e. this returns `true` and the mobile branch paints
 * first, which is the safe fallback at any width.
 */
export function useIsMobile(): boolean {
  return !useMediaQuery(MD_QUERY)
}
