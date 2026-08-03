import { motion, useReducedMotion } from 'framer-motion'
import { cn } from '@/utils/cn'

// The "loading messages" state for a group chat — deliberately SIMPLER than the
// full-screen splash (BrandReveal's node network) and the recommendations wait
// (PicksLoader). It's a small inline moment, so it stays minimal: three geometric
// diamonds that pulse and lift in sequence — a quiet wave — over one steady label.
// It shares the splash's angular geometry so the two read as the same family, but
// carries none of its orbit/wordmark weight.
//
// Reduced motion: the diamonds sit at a steady dimmed rest state, no wave.

// Left→right so the pulse reads as a wave, not random flicker.
const DOTS = [0, 1, 2]

export interface MessagesLoaderProps {
  /** Screen-reader label; also drives the visible caption. */
  label?: string
  className?: string
}

export function MessagesLoader({ label = 'Loading messages…', className }: MessagesLoaderProps) {
  const reduce = useReducedMotion()

  return (
    <div
      className={cn('flex flex-col items-center gap-4', className)}
      role="status"
      aria-label={label}
    >
      <div className="flex items-center gap-2.5">
        {DOTS.map((i) => (
          <motion.span
            key={i}
            aria-hidden="true"
            // rotate-45 turns each square into a diamond — the angular motif from
            // the splash, kept tiny. The middle one is primary so the row has a
            // small brand accent at its heart.
            className={cn('h-2.5 w-2.5 rotate-45 rounded-[2px]', i === 1 ? 'bg-primary' : 'bg-text-subtle')}
            animate={reduce ? { opacity: 0.5 } : { y: [0, -6, 0], opacity: [0.4, 1, 0.4] }}
            transition={
              reduce
                ? undefined
                : { duration: 1.1, repeat: Infinity, ease: 'easeInOut', delay: i * 0.16 }
            }
          />
        ))}
      </div>

      <p className="text-caption font-medium text-text-muted">{label}</p>
    </div>
  )
}
