import { useEffect, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Avatar, BrandMark, Icon } from '@/components/ui'
import { EASE } from '@/lib/motion'
import { memberColor } from '@/constants/memberColors'
import { cn } from '@/utils/cn'
import type { SessionMember } from '@/types'

// Personalized "finding the group's picks" loader — the Uber-Eats-style wait
// screen, but built from THIS group's real roster. A ring of member avatars
// orbits a pulsing food glyph while the status line steps through the
// reconciliation stages (profiles → budget → location → ranking), each step
// checking off as it "completes". Replaces the bare centered spinner.
//
// Presentational only: it invents no data. It reads the members handed to it and
// walks a fixed, timed script of stage copy — the real recommendation lands via
// the store, at which point TopPicksPage swaps this out for the results.

interface PicksLoaderProps {
  members: SessionMember[]
  groupName?: string
}

// The reconciliation narrative, mirrored loosely from the orchestrator's real
// work (per-profile → budget → location → ranking). Personalized where we can:
// the first step name-drops the member count so it never reads generic.
const STAGES = [
  'Reading everyone’s preferences',
  'Reconciling dietary needs',
  'Matching budgets',
  'Checking who’s nearby',
  'Ranking the best spots',
] as const

// Dwell per stage before the next lights up (ms). The last stage holds until the
// real recommendation arrives and the parent unmounts this.
const STAGE_MS = 1400

export function PicksLoader({ members, groupName }: PicksLoaderProps) {
  const reduce = useReducedMotion()
  const [stage, setStage] = useState(0)

  // Advance through the stages on a timer, stopping on the last one (it holds
  // until picks land). Reduced motion still steps — it's information, not decor —
  // just without the orbit/pulse animations below.
  useEffect(() => {
    if (stage >= STAGES.length - 1) return
    const id = setTimeout(() => setStage((s) => s + 1), STAGE_MS)
    return () => clearTimeout(id)
  }, [stage])

  // Show up to six avatars in the orbit; overflow collapses to a "+N" chip.
  const shown = members.slice(0, 6)
  const overflow = members.length - shown.length

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-8 px-6 text-center">
      {/* Orbiting roster around a pulsing food mark */}
      <div className="relative h-44 w-44">
        {/* soft glow */}
        <div className="absolute left-1/2 top-1/2 h-32 w-32 -translate-x-1/2 -translate-y-1/2 rounded-pill bg-primary-soft/40 blur-[50px]" />

        {/* the ring */}
        <motion.div
          className="absolute inset-0"
          animate={reduce ? undefined : { rotate: 360 }}
          transition={reduce ? undefined : { duration: 14, repeat: Infinity, ease: 'linear' }}
        >
          {shown.map((m, i) => {
            const angle = (i / shown.length) * 2 * Math.PI - Math.PI / 2
            const r = 74
            const x = Math.cos(angle) * r
            const y = Math.sin(angle) * r
            return (
              <div
                key={m.user_id}
                className="absolute left-1/2 top-1/2"
                style={{ transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))` }}
              >
                {/* counter-rotate so faces stay upright while the ring spins */}
                <motion.div
                  animate={reduce ? undefined : { rotate: -360 }}
                  transition={reduce ? undefined : { duration: 14, repeat: Infinity, ease: 'linear' }}
                >
                  <Avatar
                    name={m.display_name ?? m.username ?? `User ${m.user_id}`}
                    src={m.avatar_url}
                    size="sm"
                    colorClass={memberColor(m.user_id)}
                    status={m.status ? 'done' : 'active'}
                  />
                </motion.div>
              </div>
            )
          })}
        </motion.div>

        {/* center mark — the GrubChat logo, gentle pulse */}
        <motion.div
          className="absolute left-1/2 top-1/2 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-pill bg-surface-inverse shadow-lg"
          animate={reduce ? undefined : { scale: [1, 1.08, 1] }}
          transition={reduce ? undefined : { duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
        >
          {/* Optical nudge: the mark's bite (top-right) + tail (bottom-left) pull
              its visual center up-left of the geometric one, so shift it back a
              hair to sit dead-center in the disc. */}
          <BrandMark size={34} className="translate-x-[1px] translate-y-[1px] text-on-inverse" />
        </motion.div>

        {overflow > 0 && (
          <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 rounded-pill bg-surface-raised px-2 py-0.5 text-caption font-bold text-text-muted shadow-sm">
            +{overflow}
          </span>
        )}
      </div>

      {/* Headline + rotating stage line */}
      <div className="flex flex-col items-center gap-2">
        <p className="text-section-title font-bold text-text">
          {groupName ? `Finding ${groupName}’s spot…` : 'Finding the group’s spot…'}
        </p>
        <div className="h-6 overflow-hidden">
          <AnimatePresence mode="wait">
            <motion.p
              key={stage}
              initial={{ opacity: 0, y: reduce ? 0 : 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: reduce ? 0 : -8 }}
              transition={{ duration: reduce ? 0.15 : 0.28, ease: EASE }}
              className="text-body text-text-muted"
            >
              {STAGES[stage]}
            </motion.p>
          </AnimatePresence>
        </div>
      </div>

      {/* Step ticks — checked stages go green, current one pulses */}
      <ol className="flex flex-col gap-2.5 text-left">
        {STAGES.map((label, i) => {
          const done = i < stage
          const current = i === stage
          return (
            <li key={label} className="flex items-center gap-2.5">
              <span
                className={cn(
                  'flex h-5 w-5 shrink-0 items-center justify-center rounded-pill border transition-colors',
                  done && 'border-success bg-success text-on-inverse',
                  current && 'border-primary text-primary-text',
                  !done && !current && 'border-border text-transparent',
                )}
              >
                {done ? (
                  <Icon name="check" size={12} />
                ) : current ? (
                  <motion.span
                    className="h-1.5 w-1.5 rounded-pill bg-primary"
                    animate={reduce ? undefined : { scale: [1, 1.6, 1], opacity: [1, 0.5, 1] }}
                    transition={reduce ? undefined : { duration: 1.2, repeat: Infinity, ease: 'easeInOut' }}
                  />
                ) : null}
              </span>
              <span
                className={cn(
                  'text-body transition-colors',
                  done && 'text-text-muted line-through decoration-text-subtle',
                  current && 'font-medium text-text',
                  !done && !current && 'text-text-subtle',
                )}
              >
                {label}
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
