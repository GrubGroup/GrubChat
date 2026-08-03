import { useEffect, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { cn } from '@/utils/cn'

// The GrubChat splash — the branded FULL-SCREEN wait state for a cold reload / auth
// boot / session binding (NOT message history, which has its own MessagesLoader,
// and NOT recommendations, which has PicksLoader).
//
// The motif is the product itself: a small NODE NETWORK where member nodes orbit
// and pulse around a central "pick". Five identity-colored nodes circle a primary
// core on a slow infinite loop; faint spokes tie each to the center; the core
// breathes and a polygon ring counter-rotates around it — the group converging on
// one restaurant. Geometric, futuristic, on-brand — a confident loop rather than a
// spinner. The GrubChat wordmark and a rotating status line sit beneath it.
//
// Reduced motion: everything renders in a settled steady state — nodes placed, core
// at rest, no orbit / pulse / text cycling. A single static status line shows.

const EASE = [0.22, 1, 0.36, 1] as const

// SVG geometry — a 200×200 canvas centered on (100,100). Nodes sit on a ring of
// radius ORBIT; the core + its polygon live at the center.
const CENTER = 100
const ORBIT = 68

// The orbiting group — one identity color each (the same member palette the app
// uses for avatars), so the network reads as "a group", not decoration.
const NODES: { color: string; core: string }[] = [
  { color: 'text-member-terracotta', core: 'text-primary' },
  { color: 'text-member-purple', core: 'text-primary' },
  { color: 'text-member-green', core: 'text-primary' },
  { color: 'text-member-amber', core: 'text-primary' },
  { color: 'text-member-blue', core: 'text-primary' },
]

// Point on the orbit ring for node `i` of `n` (0 at top, clockwise).
function nodePoint(i: number, n: number): { x: number; y: number } {
  const angle = (i / n) * Math.PI * 2 - Math.PI / 2
  return { x: CENTER + ORBIT * Math.cos(angle), y: CENTER + ORBIT * Math.sin(angle) }
}

// A hexagon path around the center at the given radius — the counter-rotating
// polygon frame that hugs the core.
function hexPoints(r: number): string {
  return Array.from({ length: 6 }, (_, i) => {
    const a = (i / 6) * Math.PI * 2 - Math.PI / 2
    return `${(CENTER + r * Math.cos(a)).toFixed(2)},${(CENTER + r * Math.sin(a)).toFixed(2)}`
  }).join(' ')
}

// Default "loading stages" — cycled when no explicit label is supplied. Copy is
// tuned to the group-dinner story rather than generic "Loading…".
const STAGES = [
  'Warming up the kitchen…',
  'Gathering your groups…',
  'Syncing preferences…',
  'Setting the table…',
]

export interface BrandRevealProps {
  /** Fixed line under the wordmark (e.g. "Connecting you to your agent…"). When
   * omitted, the default STAGES cycle every ~1.8s. */
  label?: string
  className?: string
}

export function BrandReveal({ label, className }: BrandRevealProps) {
  const reduce = useReducedMotion()

  // Cycle the status line only when no fixed label is given and motion is allowed.
  const cycling = !label && !reduce
  const [stage, setStage] = useState(0)
  useEffect(() => {
    if (!cycling) return
    const id = setInterval(() => setStage((s) => (s + 1) % STAGES.length), 1800)
    return () => clearInterval(id)
  }, [cycling])

  const status = label ?? (reduce ? STAGES[0] : STAGES[stage])

  return (
    <motion.div
      className="flex h-dvh w-full items-center justify-center bg-surface"
      initial={reduce ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.4, ease: EASE }}
    >
      <div
        className={cn('flex flex-col items-center gap-8', className)}
        role="status"
        aria-label={label ?? 'Loading'}
      >
        {/* Node network */}
        <div className="relative h-40 w-40">
          {/* Soft brand bloom behind the core. */}
          <motion.div
            className="absolute inset-6 rounded-pill bg-primary-soft/40 blur-2xl"
            animate={reduce ? { opacity: 0.5 } : { opacity: [0.3, 0.6, 0.3], scale: [0.9, 1.05, 0.9] }}
            transition={reduce ? undefined : { duration: 3, repeat: Infinity, ease: 'easeInOut' }}
          />

          <svg viewBox="0 0 200 200" className="absolute inset-0 h-full w-full" aria-hidden="true">
            {/* Orbiting group — spokes + nodes rotate together around the center. */}
            <motion.g
              style={{ transformOrigin: '100px 100px', transformBox: 'view-box' }}
              animate={reduce ? undefined : { rotate: 360 }}
              transition={reduce ? undefined : { duration: 18, repeat: Infinity, ease: 'linear' }}
            >
              {NODES.map((n, i) => {
                const p = nodePoint(i, NODES.length)
                return (
                  <g key={i}>
                    {/* Spoke tying this member to the center pick. */}
                    <motion.line
                      x1={CENTER}
                      y1={CENTER}
                      x2={p.x}
                      y2={p.y}
                      className="stroke-border-strong"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      animate={reduce ? undefined : { opacity: [0.2, 0.6, 0.2] }}
                      transition={
                        reduce
                          ? undefined
                          : { duration: 2.2, repeat: Infinity, ease: 'easeInOut', delay: i * 0.28 }
                      }
                    />
                    {/* Member node — pulses gently toward/away from the center. */}
                    <motion.circle
                      cx={p.x}
                      cy={p.y}
                      r="7"
                      className={cn('fill-current', n.color)}
                      animate={reduce ? undefined : { scale: [1, 1.25, 1], opacity: [0.75, 1, 0.75] }}
                      style={{ transformOrigin: `${p.x}px ${p.y}px`, transformBox: 'view-box' }}
                      transition={
                        reduce
                          ? undefined
                          : { duration: 1.8, repeat: Infinity, ease: 'easeInOut', delay: i * 0.22 }
                      }
                    />
                  </g>
                )
              })}
            </motion.g>

            {/* Counter-rotating hex frame hugging the core. */}
            <motion.polygon
              points={hexPoints(26)}
              fill="none"
              className="stroke-primary/50"
              strokeWidth="1.5"
              strokeLinejoin="round"
              style={{ transformOrigin: '100px 100px', transformBox: 'view-box' }}
              animate={reduce ? undefined : { rotate: -360 }}
              transition={reduce ? undefined : { duration: 12, repeat: Infinity, ease: 'linear' }}
            />

            {/* The central "pick" — a primary core that breathes. */}
            <motion.circle
              cx={CENTER}
              cy={CENTER}
              r="12"
              className="fill-primary"
              style={{ transformOrigin: '100px 100px', transformBox: 'view-box' }}
              animate={reduce ? undefined : { scale: [1, 1.15, 1] }}
              transition={reduce ? undefined : { duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
            />
          </svg>
        </div>

        {/* Wordmark — the product name grounds the geometric motif as GrubChat. */}
        <div className="flex flex-col items-center gap-3">
          <span className="font-display text-[26px] font-extrabold leading-none">
            <span className="text-text">Grub</span>
            <span className="text-primary-text">Chat</span>
          </span>

          {/* Rotating status line — fades/slides on each change. Fixed height so the
              swap never nudges the wordmark above it. */}
          <div className="flex h-5 items-center">
            <AnimatePresence mode="wait" initial={false}>
              <motion.p
                key={status}
                initial={reduce ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce ? undefined : { opacity: 0, y: -6 }}
                transition={{ duration: 0.35, ease: EASE }}
                className="text-caption font-medium text-text-muted"
              >
                {status}
              </motion.p>
            </AnimatePresence>
          </div>
        </div>
      </div>
    </motion.div>
  )
}
