import { useState } from 'react'
import { AnimatePresence, motion, useReducedMotion, type Variants } from 'framer-motion'
import { BrandPanel } from './BrandPanel'
import { AppSplash } from './AppSplash'
import { EASE } from '@/lib/motion'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useNavStore } from '@/stores/navStore'
import { cn } from '@/utils/cn'
import { AuthForm } from '@/pages/auth/AuthForm'
import { DietaryStep } from '@/pages/member/onboarding/Onboarding1'
import { CuisinesStep } from '@/pages/member/onboarding/OnboardingCuisines'
import { BudgetStep } from '@/pages/member/onboarding/Onboarding2'
import { LocationStep } from '@/pages/member/onboarding/Onboarding3'

// ONE persistent shell for the whole entry flow: sign-in / sign-up AND the four
// onboarding steps. The BrandPanel (left) is rendered ONCE here and never
// unmounts as the user moves auth → onboarding → step-to-step, so the left panel
// never re-runs its entrance and the RIGHT content can cross-slide smoothly.
//
// A brand-new account (no profile yet) advances from sign-up to onboarding-1 via
// the nav store, which just changes which stage this shell renders — so the sign-
// up form slides left and the first onboarding question slides in from the right,
// same transition as between onboarding steps.

const TOTAL_STEPS = 4

// Each entry-flow screen is a "stage". `index` orders them along one horizontal
// track so the slide direction (left/right) is derived from the change in index:
// sign-in/up sit at 0, then onboarding steps 1..4. `step` (when present) drives
// the progress ticks; auth screens have no ticks.
interface Stage {
  index: number
  step?: number
  title?: string
  subtitle?: string
  Content: () => React.JSX.Element
  narrow?: boolean // auth form is max-w-sm; onboarding is max-w-md
}

export function AuthFlowShell() {
  const reduce = useReducedMotion()
  const screen = useNavStore((s) => s.screen)
  const go = useNavStore((s) => s.go)
  // The new-account path forwards into the app AFTER onboarding's final save; a
  // returning user with a profile forwards straight from the form. Either way the
  // AuthForm flips this to show the branded splash during that async forward.
  const [forwarding, setForwarding] = useState(false)

  const STAGES: Record<string, Stage> = {
    'sign-in': { index: 0, narrow: true, Content: () => <AuthForm mode="signin" setForwarding={setForwarding} /> },
    'sign-up': { index: 0, narrow: true, Content: () => <AuthForm mode="signup" setForwarding={setForwarding} /> },
    'onboarding-1': {
      index: 1,
      step: 1,
      title: 'Any dietary needs?',
      subtitle: "Set once — the AI remembers for every session. You'll never be asked again.",
      Content: DietaryStep,
    },
    'onboarding-2': {
      index: 2,
      step: 2,
      title: 'Cuisines you love or avoid',
      subtitle: 'Tell your agent what to lean toward and what to skip — all in one place.',
      Content: CuisinesStep,
    },
    'onboarding-3': {
      index: 3,
      step: 3,
      title: "What's your usual budget?",
      subtitle: 'Per person, per meal. You can always adjust for specific sessions.',
      Content: BudgetStep,
    },
    'onboarding-4': {
      index: 4,
      step: 4,
      title: 'Where do you usually eat?',
      subtitle: 'Helps us prioritise nearby restaurants. You can change this per session.',
      Content: LocationStep,
    },
  }

  const stage = STAGES[screen] ?? STAGES['sign-in']
  const { index, step, title, subtitle, Content, narrow } = stage

  // Derive slide direction from the change in stage index, using React's "adjust
  // state during render" pattern (track previous, compare, update in the same
  // render) — no ref reads/writes during render.
  const [prevIndex, setPrevIndex] = useState(index)
  const [direction, setDirection] = useState(1)
  if (index !== prevIndex) {
    setDirection(index > prevIndex ? 1 : -1)
    setPrevIndex(index)
  }

  // Grander cross-slide: generous horizontal travel + fade + faint scale, so a
  // stage visibly glides off while the next glides in. `custom` carries direction.
  // Shorter travel on a phone: 260px is most of a 390px viewport, so the incoming
  // stage would start entirely off-screen and read as a jump rather than a glide.
  const isMobile = useIsMobile()
  const DIST = isMobile ? 120 : 260
  const slide: Variants = {
    enter: (dir: number) => ({ opacity: 0, x: reduce ? 0 : dir * DIST, scale: reduce ? 1 : 0.96 }),
    center: {
      opacity: 1,
      x: 0,
      scale: 1,
      transition: { duration: reduce ? 0.2 : 0.5, ease: EASE },
    },
    exit: (dir: number) => ({
      opacity: 0,
      x: reduce ? 0 : dir * -DIST,
      scale: reduce ? 1 : 0.96,
      transition: { duration: reduce ? 0.15 : 0.5, ease: EASE },
    }),
  }

  // Credentials accepted and forwarding into the app — keep the branded loader up
  // so the form never flashes behind the destination screen.
  if (forwarding) return <AppSplash />

  return (
    // min-h-dvh, not h-dvh: a tall onboarding step (the 6-group cuisine picker) is
    // taller than a phone viewport, and a fixed height with `overflow-hidden` below
    // CLIPPED it with no way to scroll — the final save was unreachable, so a new
    // mobile user couldn't finish signup at all.
    <div className="flex min-h-dvh bg-surface-raised">
      {/* Persistent left panel — rendered once, never remounts across the flow. */}
      <BrandPanel onLogoClick={() => go('landing')} />
      {/* overflow-x-clip, not hidden: the cross-slide travels horizontally and would
          otherwise cause transient horizontal scroll, but `overflow-hidden` on both
          axes is what clipped tall steps. Vertical centering only from `sm` up,
          where the content reliably fits the viewport. */}
      <div className="flex min-w-0 flex-1 justify-center overflow-y-auto overflow-x-clip p-4 sm:items-center sm:p-8">
        <div className={cn('flex w-full flex-col gap-5 py-4 sm:py-0', narrow ? 'max-w-sm' : 'max-w-md')}>
          {/* Progress ticks — only during onboarding; persist + driven by `step`. */}
          {step != null && (
            <div className="flex gap-2">
              {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
                <span
                  key={i}
                  className={cn(
                    'h-1 flex-1 rounded-pill transition-colors duration-300',
                    i < step ? 'bg-text' : 'bg-text/15',
                  )}
                />
              ))}
            </div>
          )}
          {/* Carousel viewport: only the right content swaps + cross-slides. */}
          <div className="relative">
            <AnimatePresence mode="popLayout" custom={direction} initial={false}>
              <motion.div
                key={screen}
                custom={direction}
                variants={slide}
                initial="enter"
                animate="center"
                exit="exit"
                className="flex flex-col gap-5"
              >
                {step != null && (
                  <div>
                    <p className="text-overline font-semibold uppercase tracking-wide text-text-muted">
                      Step {step} of {TOTAL_STEPS}
                    </p>
                    <h1 className="mt-1 font-display text-display font-bold text-text">{title}</h1>
                    <p className="mt-1 text-body text-text-muted">{subtitle}</p>
                  </div>
                )}
                <Content />
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  )
}
