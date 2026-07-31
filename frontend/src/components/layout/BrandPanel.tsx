import { useEffect, useState, type ReactNode } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { Icon, Wordmark } from '@/components/ui'
import { makeFadeUp, makeFloat } from '@/lib/motion'
import { cn } from '@/utils/cn'

export interface BrandPanelProps {
  /** When provided, the wordmark becomes a button that calls this (auth screens
   * use it to return to the landing page). Omitted elsewhere (e.g. onboarding),
   * so the wordmark stays a static, non-interactive label. */
  onLogoClick?: () => void
}

// BrandPanel appears on both the auth screens and the onboarding shell. This
// module-level flag plays the staggered entrance only on the FIRST mount of the
// session; later mounts (e.g. navigating auth → onboarding) start already-shown so
// the entrance never replays. The panel now stays mounted across the entire entry
// flow (sign-in/up + all onboarding steps; see AuthFlowShell), so it no longer
// remounts between those screens at all.
let hasEntered = false

// The panel's identity avatars (overlapping, member-color coded).
const AVATARS = [
  { c: 'bg-member-terracotta', l: 'S' },
  { c: 'bg-member-purple', l: 'D' },
  { c: 'bg-member-green', l: 'M' },
  { c: 'bg-member-amber', l: 'T' },
] as const

// Dark brand panel shown on the left of the auth + onboarding screens. Layered,
// landing-style motion (glow depth, tilted floating cards, staggered entrance)
// on the same dark palette.
export function BrandPanel({ onLogoClick }: BrandPanelProps = {}) {
  const reduce = !!useReducedMotion()
  const fu = makeFadeUp(reduce)
  const float = makeFloat(reduce)

  // Replay-guard: after the first mount, subsequent mounts skip the entrance.
  const [initial] = useState(hasEntered ? 'show' : 'hidden')
  useEffect(() => {
    hasEntered = true
  }, [])

  const logo = <Wordmark dark />

  return (
    <div className="relative hidden w-[38%] shrink-0 flex-col justify-between overflow-hidden bg-surface-inverse p-10 text-on-inverse dark:bg-surface lg:flex">
      {/* Depth layers — behind content, never intercept clicks/focus */}
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        <div className="absolute -right-16 top-24 h-72 w-72 rounded-pill bg-primary/20 blur-[120px]" />
        <div className="absolute -bottom-10 -left-10 h-56 w-56 rounded-pill bg-member-purple/15 blur-[110px]" />
        <div className="absolute inset-x-0 top-0 h-1/3 bg-gradient-to-b from-on-inverse/[0.04] to-transparent" />
      </div>

      {/* Staggered entrance over the three vertical bands */}
      <motion.div
        initial={initial}
        animate="show"
        variants={{ show: { transition: { staggerChildren: 0.09, delayChildren: 0.05 } } }}
        className="relative flex h-full flex-col justify-between"
      >
        {/* Top — logo */}
        <motion.div variants={fu}>
          {onLogoClick ? (
            <button
              type="button"
              onClick={onLogoClick}
              aria-label="Go to home"
              className="flex items-center gap-2.5 rounded-lg transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-on-inverse/50"
            >
              {logo}
            </button>
          ) : (
            <div className="flex items-center gap-2.5">{logo}</div>
          )}
        </motion.div>

        {/* Middle — tilted floating card cluster + tagline */}
        <div className="flex flex-col gap-8">
          <motion.div variants={fu} className="relative mx-auto h-[240px] w-full max-w-[300px]">
            {/* Dish chips (back, tilted left) */}
            <FloatCard float={float(0)} rotate={-4} className="left-0 top-3 w-[58%]">
              <div className="flex gap-2 rounded-2xl border border-on-inverse/10 bg-on-inverse/[0.06] p-3 shadow-[0_18px_44px_var(--shadow-tint-deep)] backdrop-blur-sm">
                {['🍱', '🍕', '🍷'].map((e) => (
                  <span
                    key={e}
                    className="flex h-10 w-10 items-center justify-center rounded-xl bg-on-inverse/10 text-xl"
                  >
                    {e}
                  </span>
                ))}
              </div>
            </FloatCard>

            {/* AI consensus bubble (top-right, tilted right) */}
            <FloatCard float={float(1.2, 6)} rotate={2} className="right-0 top-0 w-[64%]">
              <div className="flex items-start gap-2.5 rounded-2xl border border-primary/25 bg-on-inverse/[0.06] p-3 shadow-[0_20px_50px_var(--shadow-tint-deep)] backdrop-blur-sm">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary-text">
                  <Icon name="sparkles" size={15} />
                </span>
                <p className="text-caption leading-snug text-on-inverse">
                  Found 3 spots you&apos;ll all love.
                </p>
              </div>
            </FloatCard>

            {/* Restaurant match (focal, front, biggest shadow) */}
            <FloatCard float={float(0.6, 12)} rotate={4} className="bottom-0 left-1/2 w-[68%] -translate-x-1/2">
              <div className="overflow-hidden rounded-[16px] bg-surface-raised text-text shadow-[0_30px_70px_var(--shadow-tint-deep)]">
                <div className="relative h-16 bg-gradient-to-br from-member-terracotta to-primary">
                  <span className="absolute left-2.5 top-2.5 rounded-pill bg-surface-raised px-2 py-0.5 text-caption font-bold text-primary-text">
                    98% match
                  </span>
                </div>
                <div className="p-3">
                  <p className="text-item-title font-bold">Verde Cocina</p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {['Vegan', '$$'].map((t) => (
                      <span
                        key={t}
                        className="rounded-pill bg-surface-sunken px-2 py-0.5 text-caption font-medium"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </FloatCard>
          </motion.div>

          <motion.h1 variants={fu} className="font-display text-4xl font-bold leading-tight">
            The restaurant
            <br />
            everyone agrees on.
          </motion.h1>

          <motion.p variants={fu} className="max-w-xs text-body text-on-inverse/60">
            Every person talks to their own AI agent. One result that works for the whole group.
          </motion.p>

          <motion.div variants={fu} className="flex items-center gap-3">
            <div className="flex -space-x-2">
              {AVATARS.map((m) => (
                <span
                  key={m.l}
                  className={cn(
                    'flex h-7 w-7 items-center justify-center rounded-pill border-2 border-surface-inverse text-caption font-semibold dark:border-surface',
                    m.c,
                  )}
                >
                  {m.l}
                </span>
              ))}
            </div>
            <span className="text-caption text-on-inverse/60">Joined by thousands of groups</span>
          </motion.div>
        </div>

        {/* Bottom — footer */}
        <motion.p variants={fu} className="text-caption text-on-inverse/60">
          © 2026 GrubChat
        </motion.p>
      </motion.div>
    </div>
  )
}

// One absolutely-positioned tilted card: static rotate + an inner motion.div that
// runs the idle float loop (empty object when reduced → no loop). Entrance is
// handled by the parent stagger (this card sits inside a `variants={fu}` band).
function FloatCard({
  float,
  rotate,
  className,
  children,
}: {
  float: object
  rotate: number
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cn('absolute', className)} style={{ rotate: `${rotate}deg` }}>
      <motion.div {...float}>{children}</motion.div>
    </div>
  )
}
