import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Button, Input, Icon } from '@/components/ui'
import { DIETARY_RESTRICTIONS, labelFor } from '@/constants/dietary'
import { usePlacesInput } from '@/hooks/usePlacesInput'
import { useProfileStore } from '@/stores/profileStore'
import { cn } from '@/utils/cn'

// Radius options in miles; label is derived. 1 mi is the default.
const DISTANCES = [0.5, 1, 2, 5]
const DEFAULT_RADIUS = 1

// Onboarding step 4 of 4 content (default location + radius, profile summary, and
// the final save). Rendered inside AuthFlowShell.
export function LocationStep() {
  const navigate = useNavigate()
  const profile = useProfileStore((s) => s.profile)
  const save = useProfileStore((s) => s.save)
  const saving = useProfileStore((s) => s.saving)
  const setLocation = useProfileStore((s) => s.setLocation)
  const setRadius = useProfileStore((s) => s.setRadius)
  // Prefill from any already-set default address, else a sensible placeholder.
  const { value, setValue } = usePlacesInput(profile?.default_address ?? 'San Francisco, CA')

  const [error, setError] = useState<string | null>(null)

  const dietary = profile?.dietary_restrictions ?? []
  const radius = profile?.default_radius ?? DEFAULT_RADIUS

  const handleDone = async () => {
    // Persist the typed address onto the profile before saving. (No geocoding
    // wired yet, so we store the label only; lat/lon stay null — see
    // usePlacesInput.) Also lock in the selected radius. save() upserts the
    // whole profile via the gateway.
    setError(null)
    setLocation(value)
    setRadius(radius)
    // Only advance once the save actually succeeded — otherwise surface an error
    // instead of silently trapping the user on this step.
    const ok = await save()
    if (ok) {
      navigate('/groups')
    } else {
      setError('Could not save your profile. Please try again.')
    }
  }

  return (
    <>
      <Input label="DEFAULT ADDRESS" value={value} onChange={(e) => setValue(e.target.value)} />

      <div className="flex flex-col gap-2">
        <span className="text-overline font-semibold uppercase tracking-wide text-text-muted">
          Max distance
        </span>
        <div className="flex gap-2">
          {DISTANCES.map((d) => (
            <button
              key={d}
              onClick={() => setRadius(d)}
              className={cn(
                'flex-1 rounded-input border px-3 py-2 text-sm font-medium transition-colors',
                d === radius
                  ? 'border-text bg-surface-inverse text-white'
                  : 'border-border bg-surface-sunken text-text hover:border-border-strong',
              )}
            >
              {d} mi
            </button>
          ))}
        </div>
      </div>

      {/* Profile summary card */}
      <div className="flex flex-col gap-1.5 rounded-card bg-surface-sunken p-4 text-sm text-text">
        <span className="text-overline font-semibold uppercase tracking-wide text-text-muted">
          Your profile
        </span>
        {dietary.map((d) => (
          <span key={d} className="flex items-center gap-1.5">
            <Icon name="x" size={12} /> {labelFor(DIETARY_RESTRICTIONS, d)}
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <Icon name="wallet" size={13} /> Budget: ${profile?.budget_min}–${profile?.budget_max} per
          person
        </span>
        <span className="flex items-center gap-1.5">
          <Icon name="map-pin" size={13} /> {value} · within {radius} mi
        </span>
      </div>

      {error && <p className="text-sm text-error">{error}</p>}

      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          leftIcon={<Icon name="arrow-left" size={14} />}
          onClick={() => navigate('/onboarding/budget')}
          disabled={saving}
        >
          Back
        </Button>
        <Button variant="primary" fullWidth onClick={handleDone} isLoading={saving}>
          Done — let's eat
        </Button>
      </div>
    </>
  )
}
