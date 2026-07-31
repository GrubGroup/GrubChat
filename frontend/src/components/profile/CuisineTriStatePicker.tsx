import { CUISINE_GROUPS } from '@/constants/dietary'
import { Icon } from '@/components/ui'
import { cn } from '@/utils/cn'

// One chip, three states: neutral → like (green) → avoid (rose) → neutral.
// Lets a diner set both preferences in a single onboarding step and makes it
// impossible to mark a cuisine as both liked and disliked. Colors mirror the
// profile pills (preferred = green, disliked = rose/neutral).
export type CuisineState = 'neutral' | 'like' | 'avoid'

export interface CuisineTriStatePickerProps {
  /** Currently-liked cuisine tokens (profile.preferred_cuisines). */
  liked: string[]
  /** Currently-disliked cuisine tokens (profile.disliked_cuisines). */
  disliked: string[]
  /** Advance a cuisine to the next state in the cycle. */
  onCycle: (value: string, next: CuisineState) => void
}

function nextState(current: CuisineState): CuisineState {
  return current === 'neutral' ? 'like' : current === 'like' ? 'avoid' : 'neutral'
}

export function CuisineTriStatePicker({ liked, disliked, onCycle }: CuisineTriStatePickerProps) {
  const stateOf = (value: string): CuisineState =>
    liked.includes(value) ? 'like' : disliked.includes(value) ? 'avoid' : 'neutral'

  return (
    <div className="flex flex-col gap-4">
      {/* Legend */}
      <p className="text-caption text-text-muted">
        Tap once to <span className="font-medium text-success">like</span>, twice to{' '}
        <span className="font-medium text-error">avoid</span>, again to clear.
      </p>

      {CUISINE_GROUPS.map((group) => (
        <div key={group.region} className="flex flex-col gap-2">
          <span className="text-overline font-semibold uppercase tracking-wide text-text-muted">
            {group.region}
          </span>
          <div className="flex flex-wrap gap-2">
            {group.options.map((opt) => {
              const state = stateOf(opt.value)
              return (
                <button
                  key={opt.value}
                  type="button"
                  aria-label={`${opt.label}: ${state}`}
                  onClick={() => onCycle(opt.value, nextState(state))}
                  className={cn(
                    // tap-target matches Chip: the pill stays ~34px, the hit area
                    // reaches 44px. This grid is the densest tap zone in the app.
                    'tap-target inline-flex items-center gap-1.5 rounded-pill border px-3.5 py-1.5 text-body font-medium',
                    'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring',
                    state === 'like' &&
                      'border-success bg-success/12 text-success',
                    state === 'avoid' &&
                      'border-error bg-error/12 text-error',
                    state === 'neutral' &&
                      'border-border bg-surface-sunken text-text-muted hover:border-border-strong',
                  )}
                >
                  {state === 'like' && <Icon name="check" size={12} />}
                  {state === 'avoid' && <Icon name="x" size={12} />}
                  {opt.label}
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
