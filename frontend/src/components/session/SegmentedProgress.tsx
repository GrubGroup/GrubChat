import { motion, useReducedMotion } from 'framer-motion'
import { EASE } from '@/lib/motion'
import { cn } from '@/utils/cn'

export interface SegmentedProgressProps {
  value: number
  total: number
  tone?: 'dark' | 'primary'
}

// Segmented progress indicator (one bar per member) matching the wireframe. Each
// segment fills with a left-anchored sweep as a member finishes — the product's
// "everyone's ready" moment — so progress reads as motion, not a snap. The track
// stays put; a colored overlay scales in over each filled slot. Reduced-motion
// falls back to the instant class swap.
export function SegmentedProgress({ value, total, tone = 'dark' }: SegmentedProgressProps) {
  const reduce = useReducedMotion()
  const fill = tone === 'primary' ? 'bg-primary' : 'bg-text'
  return (
    <div className="flex items-center gap-1">
      {Array.from({ length: total }).map((_, i) => {
        const filled = i < value
        // min-w-[3px]: with many members, flex-1 segments go sub-pixel in a
        // narrow mobile strip and the bar reads as an empty line.
        if (reduce) {
          return (
            <span
              key={i}
              className={cn('h-1.5 min-w-[3px] flex-1 rounded-pill', filled ? fill : 'bg-text/10')}
            />
          )
        }
        return (
          <span
            key={i}
            className="relative h-1.5 min-w-[3px] flex-1 overflow-hidden rounded-pill bg-text/10"
          >
            <motion.span
              className={cn('absolute inset-0 rounded-pill', fill)}
              initial={false}
              animate={{ scaleX: filled ? 1 : 0 }}
              transition={{ duration: 0.4, ease: EASE }}
              style={{ transformOrigin: 'left' }}
            />
          </span>
        )
      })}
    </div>
  )
}
