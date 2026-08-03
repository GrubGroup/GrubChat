import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Button, Input, Icon } from '@/components/ui'
import { DIETARY_RESTRICTIONS, labelFor } from '@/constants/dietary'
import { usePlacesInput } from '@/hooks/usePlacesInput'
import { geocodeAddress } from '@/api/sessionApi'
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
  // Prefill from any already-set default address, else start empty (a placeholder
  // guides entry). The SAME picker the host session modal + profile editor use:
  // Geoapify autocomplete via usePlacesInput plus a suggestions dropdown, so the
  // default address is chosen the same way and captures real coordinates.
  const { value, setValue, suggestions, select, clear } = usePlacesInput(
    profile?.default_address ?? '',
  )
  // Coords from a picked suggestion (or the blur geocode), committed on Done.
  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(null)
  const [locFocused, setLocFocused] = useState(false)
  const [geoStatus, setGeoStatus] = useState<'idle' | 'checking' | 'ok' | 'notfound'>('idle')

  const [error, setError] = useState<string | null>(null)

  const dietary = profile?.dietary_restrictions ?? []
  const radius = profile?.default_radius ?? DEFAULT_RADIUS

  // Editing the address invalidates a prior pick's coordinates + status.
  const handleAddressChange = (v: string) => {
    setValue(v)
    if (coords) setCoords(null)
    if (geoStatus !== 'idle') setGeoStatus('idle')
  }

  // Pick a suggestion: resolve its address + coordinates from the cached
  // autocomplete result (no extra request); select() fills the field text.
  const handleSelectSuggestion = (placeId: string) => {
    const place = select(placeId)
    if (place) {
      setCoords({ lat: place.lat, lon: place.lon })
      setGeoStatus('ok')
    } else {
      setGeoStatus('notfound')
    }
  }

  // Confirm a typed-but-unpicked address on blur via the server /geocode,
  // backfilling coordinates when found — the same fallback the host modal uses.
  const validateAddressOnBlur = async () => {
    const trimmed = value.trim()
    if (!trimmed || coords) return // empty, or a pick already gave coords
    setGeoStatus('checking')
    try {
      const res = await geocodeAddress(trimmed)
      if (res.ok && res.lat != null && res.lon != null) {
        setCoords({ lat: res.lat, lon: res.lon })
        setGeoStatus('ok')
      } else {
        setGeoStatus(res.ok ? 'ok' : 'notfound')
      }
    } catch {
      setGeoStatus('notfound')
    }
  }

  const handleDone = async () => {
    // The location must resolve to a real place before finishing onboarding
    // (parity with the session's start gate). Use a picked / blur-resolved coord
    // when we have one; otherwise geocode the typed address now. Abort with an
    // error when it's empty or can't be verified — don't advance on a bad address.
    setError(null)
    const addr = value.trim()
    let finalCoords = coords
    if (!finalCoords && addr) {
      setGeoStatus('checking')
      try {
        const res = await geocodeAddress(addr)
        if (res.ok && res.lat != null && res.lon != null) {
          finalCoords = { lat: res.lat, lon: res.lon }
          setGeoStatus('ok')
        }
      } catch {
        // fall through to the invalid-location guard below
      }
    }
    if (!addr || !finalCoords) {
      if (addr) setGeoStatus('notfound')
      setError('Enter a valid location to continue.')
      return
    }
    // Persist the resolved address + coordinates and the selected radius, then
    // save. save() upserts the whole profile via the gateway.
    setLocation(addr, finalCoords)
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
      <div className="relative">
        <Input
          label="DEFAULT ADDRESS"
          value={value}
          onChange={(e) => handleAddressChange(e.target.value)}
          onFocus={() => setLocFocused(true)}
          onBlur={() => {
            // Delay so a suggestion click (onMouseDown) registers before we close
            // the dropdown / kick off validation.
            window.setTimeout(() => {
              setLocFocused(false)
              void validateAddressOnBlur()
            }, 150)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') clear()
          }}
          leftIcon={<Icon name="map-pin" size={16} />}
          placeholder="e.g. Market Street, San Francisco"
          error={geoStatus === 'notfound' ? "Couldn't find that place — try another." : undefined}
          hint={geoStatus === 'ok' ? '✓ Location confirmed' : undefined}
        />
        {locFocused && suggestions.length > 0 && (
          <ul
            className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-input border border-border bg-surface py-1 shadow-lg"
            role="listbox"
          >
            {suggestions.map((s) => (
              <li key={s.placeId}>
                <button
                  type="button"
                  // onMouseDown fires before the input's onBlur, so the pick isn't
                  // lost to the blur-close above.
                  onMouseDown={(e) => {
                    e.preventDefault()
                    handleSelectSuggestion(s.placeId)
                  }}
                  className="flex w-full items-start gap-2 px-3 py-2 text-left text-body text-text hover:bg-surface-sunken"
                >
                  <Icon name="map-pin" size={14} className="mt-0.5 shrink-0 text-text-muted" />
                  <span>{s.description}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-overline font-semibold uppercase tracking-wide text-text-muted">
          Max distance
        </span>
        {/* 2×2 below `sm`, one row above: four flex-1 siblings squeeze "0.5 mi" to
            the edge of its 44px-tall box at 390px. min-h-11 makes each a real
            touch target without changing the desktop row's look. */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {DISTANCES.map((d) => (
            <button
              key={d}
              onClick={() => setRadius(d)}
              className={cn(
                'flex min-h-11 items-center justify-center rounded-input border px-3 py-2 text-body font-medium transition-colors',
                d === radius
                  ? 'border-text bg-surface-inverse text-on-inverse'
                  : 'border-border bg-surface-sunken text-text hover:border-border-strong',
              )}
            >
              {d} mi
            </button>
          ))}
        </div>
      </div>

      {/* Profile summary card */}
      <div className="flex flex-col gap-1.5 rounded-card bg-surface-sunken p-4 text-body text-text">
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
          <Icon name="map-pin" size={13} /> {value.trim() || 'No address yet'} · within {radius} mi
        </span>
      </div>

      {error && <p className="text-body text-error-text">{error}</p>}

      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          leftIcon={<Icon name="arrow-left" size={14} />}
          onClick={() => navigate('/onboarding/budget')}
          disabled={saving}
        >
          Back
        </Button>
        <Button
          variant="primary"
          fullWidth
          onClick={handleDone}
          isLoading={saving || geoStatus === 'checking'}
        >
          Done — let's eat
        </Button>
      </div>
    </>
  )
}
