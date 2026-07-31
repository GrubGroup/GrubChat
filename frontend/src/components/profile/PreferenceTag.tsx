import type { ReactNode } from 'react'
import { cn } from '@/utils/cn'

// Semantic pill tones for the profile taxonomy (matches the wireframe):
// - allergy  → purple (safety-critical "avoid")
// - diet     → blue   (lifestyle / religious, informational)
// - preferred→ green  ("want")
// - disliked → red    ("avoid" — mirrors the preferred pill, matching the
//   like=green / avoid=red cycle in CuisineTriStatePicker)
export type PreferenceTone = 'allergy' | 'diet' | 'preferred' | 'disliked'

const toneClasses: Record<PreferenceTone, { dot: string; pill: string }> = {
  allergy: { dot: 'bg-member-purple', pill: 'bg-member-purple/12 text-member-purple' },
  diet: { dot: 'bg-member-blue', pill: 'bg-member-blue/12 text-member-blue' },
  preferred: { dot: 'bg-success', pill: 'bg-success/12 text-success' },
  disliked: { dot: 'bg-error', pill: 'bg-error/12 text-error' },
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
