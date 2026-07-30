import type { ReactNode } from 'react'
import { cn } from '@/utils/cn'

// Semantic pill tones for the profile taxonomy (matches the wireframe):
// - allergy  → caution (safety-critical "avoid")
// - diet     → info    (lifestyle / religious, informational)
// These used to borrow member-purple / member-blue — the only two places in the
// app where an IDENTITY hue was used as text. They are categories, not people,
// so they now have their own tones and the identity ramp stays fill-only.
// - preferred→ green  ("want")
// - disliked → red    ("avoid" — mirrors the preferred pill, matching the
//   like=green / avoid=red cycle in CuisineTriStatePicker)
export type PreferenceTone = 'allergy' | 'diet' | 'preferred' | 'disliked'

const toneClasses: Record<PreferenceTone, { dot: string; pill: string }> = {
  allergy: { dot: 'bg-caution', pill: 'bg-caution/12 text-caution-text' },
  diet: { dot: 'bg-info', pill: 'bg-info/12 text-info-text' },
  preferred: { dot: 'bg-success', pill: 'bg-success/12 text-success-text' },
  disliked: { dot: 'bg-error', pill: 'bg-error/12 text-error-text' },
}

export interface PreferenceTagProps {
  tone: PreferenceTone
  children: ReactNode
  /** Show the leading status dot (hidden for neutral disliked tone). */
  dot?: boolean
}

export function PreferenceTag({ tone, children, dot = true }: PreferenceTagProps) {
  const c = toneClasses[tone]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-pill px-3 py-1.5 text-body font-medium',
        c.pill,
      )}
    >
      {dot && c.dot && <span className={cn('h-1.5 w-1.5 rounded-full', c.dot)} />}
      {children}
    </span>
  )
}
