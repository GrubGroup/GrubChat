import type { ReactNode } from 'react'
import { cn } from '@/utils/cn'

type BadgeTone = 'neutral' | 'primary' | 'success' | 'error' | 'kraft'

export interface BadgeProps {
  tone?: BadgeTone
  className?: string
  children: ReactNode
}

// Non-interactive label. For cuisine/dietary tags, price level, match score, etc.
const toneClasses: Record<BadgeTone, string> = {
  neutral: 'bg-surface-sunken text-text-muted',
  primary: 'bg-primary/10 text-primary-hover',
  success: 'bg-success/10 text-success',
  error: 'bg-error/10 text-error',
  kraft: 'bg-secondary/15 text-secondary',
}

export function Badge({ tone = 'neutral', className, children }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-pill px-2.5 py-0.5 text-caption font-medium',
        toneClasses[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}
