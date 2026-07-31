import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { Avatar, Button, Chip, Icon, Input } from '@/components/ui'
import { CuisineTriStatePicker } from '@/components/profile/CuisineTriStatePicker'
import { DIETARY_RESTRICTIONS, isAllergen } from '@/constants/dietary'
import { updateMe, UserUpdateError } from '@/api/userApi'
import { useAuthStore } from '@/stores/authStore'
import { memberColor } from '@/constants/memberColors'
import { useProfileStore } from '@/stores/profileStore'

const DIET_OPTIONS = DIETARY_RESTRICTIONS.filter((o) => !isAllergen(o.value))
const ALLERGEN_OPTIONS = DIETARY_RESTRICTIONS.filter((o) => isAllergen(o.value))

const BUDGET_BANDS = [
  { label: 'Under $15', min: 0, max: 15 },
  { label: '$15–25', min: 15, max: 25 },
  { label: '$25–40', min: 25, max: 40 },
  { label: '$40+', min: 40, max: 200 },
]

// Preferred search radius options (miles) — mirrors the onboarding choices.
const RADIUS_OPTIONS = [0.5, 1, 2, 5]

// Edit form for identity (User: display_name, username) + preferences (Profile).
// Mirrors the "[Orange] Edit Profile" wireframe. Saves User via PATCH /user
// (with username-uniqueness error surfacing) and Profile via the profile store.
export function ProfileEditPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const user = useAuthStore((s) => s.user)
  const patchUser = useAuthStore((s) => s.patchUser)

  // Leaving the editor (Back, Cancel, and Save) returns to the profile view by popping
  // history (navigate(-1)) rather than pushing /profile — a push leaves a dangling
  // /profile/edit entry that the profile view's own Back then returns to, trapping the
  // user in a profile ↔ edit loop that never reaches /groups. A 'default' key means the
  // editor was the entry point (deep link / refresh) with nothing to pop, so replace it
  // with the profile view (replace, not push, so Back still can't land back on the editor).
  const goBack = () => (location.key === 'default' ? navigate('/profile', { replace: true }) : navigate(-1))

  const profile = useProfileStore((s) => s.profile)
  const load = useProfileStore((s) => s.load)
  const save = useProfileStore((s) => s.save)
  const saving = useProfileStore((s) => s.saving)
  const toggleDietary = useProfileStore((s) => s.toggleDietary)
  const setCuisineState = useProfileStore((s) => s.setCuisineState)
  const setBudget = useProfileStore((s) => s.setBudget)
  const setLocation = useProfileStore((s) => s.setLocation)
  const setRadius = useProfileStore((s) => s.setRadius)

  // Local identity draft for User fields (not in the profile store). Lazy-init
  // from the session user, which is available synchronously by the time this
  // page is reached (always navigated to from the authenticated profile view).
  const [displayName, setDisplayName] = useState(() => user?.display_name ?? '')
  const [username, setUsername] = useState(() => user?.username ?? '')
  const [usernameError, setUsernameError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [savingUser, setSavingUser] = useState(false)

  useEffect(() => {
    if (!profile) void load()
  }, [profile, load])

  // Location lives on the profile store; edit it live like budget/chips do.
  const address = profile?.default_address ?? ''
  const radius = profile?.default_radius ?? 1

  const dietary = profile?.dietary_restrictions ?? []
  const preferred = profile?.preferred_cuisines ?? []
  const disliked = profile?.disliked_cuisines ?? []
  const budgetMin = profile?.budget_min ?? 15
  const budgetMax = profile?.budget_max ?? 25

  const handleSave = async () => {
    setFormError(null)
    setUsernameError(null)

    // 1) Persist identity (User) first so a username conflict aborts before we
    //    save preferences — the user stays on the form with the error shown.
    const identityPatch: { display_name?: string | null; username?: string } = {}
    if (displayName !== (user?.display_name ?? '')) identityPatch.display_name = displayName || null
    if (username !== (user?.username ?? '')) identityPatch.username = username

    if (Object.keys(identityPatch).length > 0) {
      setSavingUser(true)
      try {
        const updated = await updateMe(identityPatch)
        patchUser(updated)
      } catch (err) {
        setSavingUser(false)
        if (err instanceof UserUpdateError && err.status === 409) {
          setUsernameError(err.message)
        } else if (err instanceof UserUpdateError && err.status === 400) {
          setUsernameError(err.message)
        } else {
          setFormError(err instanceof Error ? err.message : 'Could not save your account.')
        }
        return
      }
      setSavingUser(false)
    }

    // 2) Persist preferences (Profile). Location was written live via setLocation.
    //    Only leave the form once the save succeeded, so a failure shows an error
    //    instead of silently discarding the edit.
    const ok = await save()
    if (!ok) {
      setFormError('Could not save your preferences. Please try again.')
      return
    }
    goBack()
  }

  const displayNameLabel = displayName || user?.username || 'You'

  return (
    <div className="h-dvh overflow-y-auto bg-surface-raised">
      <div className="mx-auto max-w-3xl">
        {/* Header bar */}
        <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-6 sm:px-8">
          <div className="min-w-0">
            <button
              onClick={goBack}
              className="tap-target mb-2 flex items-center gap-1 text-body text-text-muted hover:text-text"
            >
              <Icon name="chevron-left" size={14} /> Back
            </button>
            <h1 className="font-display text-display font-bold text-text">Edit profile</h1>
            <p className="text-body text-text-muted">
              Update your details — your agent uses these across every session
            </p>
          </div>
          {/* The footer Cancel is the reachable one at phone width; this duplicate
              would only crowd the title, and Back already leaves the form. Hidden
              on a wrapper, not on the Button — `hidden` on the Button would have to
              out-specify its own `inline-flex` base class. */}
          <div className="hidden shrink-0 sm:block">
            <Button variant="ghost" onClick={goBack}>
              Cancel
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-7 px-4 py-6 sm:px-8">
          {/* Profile photo */}
          <Field label="Profile photo">
            {/* Wraps below `sm`: avatar + name + a "Change photo" button is ~330px
                of content before padding, so the button drops to its own line
                instead of squeezing the name to nothing. */}
            <div className="flex flex-wrap items-center gap-4 rounded-card border border-border p-4">
              <Avatar
                name={displayNameLabel}
                src={user?.avatar_url}
                size="lg"
                colorClass={memberColor(user?.id ?? -1)}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-body font-semibold text-text">{displayNameLabel}</p>
                <p className="text-caption text-text-muted">PNG or JPG, up to 5MB</p>
              </div>
              <Button variant="primary" size="sm" leftIcon={<Icon name="plus" size={13} />} disabled>
                Change photo
              </Button>
            </div>
          </Field>

          {/* Identity */}
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <Field label="Display name">
              <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Dev Patel" />
            </Field>
            <Field label="Username">
              <Input
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value)
                  if (usernameError) setUsernameError(null)
                }}
                placeholder="devpatel"
                error={usernameError ?? undefined}
                hint={usernameError ? undefined : '3–30 chars: letters, numbers, dots, underscores.'}
              />
            </Field>
          </div>

          <Field label="Default address">
            <Input
              value={address}
              onChange={(e) => setLocation(e.target.value)}
              leftIcon={<Icon name="map-pin" size={16} />}
              placeholder="e.g. Market Street, San Francisco"
            />
          </Field>

          <Field label="Max distance">
            <div className="flex flex-wrap gap-2">
              {RADIUS_OPTIONS.map((mi) => (
                <Chip
                  key={mi}
                  label={`${mi} mi`}
                  selected={mi === radius}
                  onToggle={() => setRadius(mi)}
                />
              ))}
            </div>
          </Field>

          {/* Budget */}
          <Field label="Typical budget (per person)">
            <div className="flex flex-wrap gap-2">
              {BUDGET_BANDS.map((b) => (
                <Chip
                  key={b.label}
                  label={b.label}
                  selected={b.min === budgetMin && b.max === budgetMax}
                  onToggle={() => setBudget(b.min, b.max)}
                />
              ))}
            </div>
          </Field>

          {/* Dietary needs */}
          <Field label="Dietary needs">
            <div className="flex flex-wrap gap-2">
              {DIET_OPTIONS.map((opt) => (
                <Chip
                  key={opt.value}
                  label={opt.label}
                  selected={dietary.includes(opt.value)}
                  onToggle={() => toggleDietary(opt.value)}
                />
              ))}
            </div>
          </Field>

          {/* Allergies */}
          <Field label="Allergies">
            <div className="flex flex-wrap gap-2">
              {ALLERGEN_OPTIONS.map((opt) => (
                <Chip
                  key={opt.value}
                  label={opt.label}
                  selected={dietary.includes(opt.value)}
                  onToggle={() => toggleDietary(opt.value)}
                />
              ))}
            </div>
          </Field>

          {/* Cuisines — one tri-state grid (like / avoid / neutral) instead of
              two full grids, matching the onboarding step. */}
          <Field label="Cuisines">
            <CuisineTriStatePicker
              liked={preferred}
              disliked={disliked}
              onCycle={setCuisineState}
            />
          </Field>

          {formError && <p className="text-body text-error-text">{formError}</p>}

          {/* Actions — reversed and stacked below `sm` so Save is the wide button
              closest to the thumb, with Cancel beneath it. */}
          <div className="flex flex-col-reverse gap-3 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-end">
            <Button variant="ghost" fullWidth className="sm:w-auto" onClick={goBack}>
              Cancel
            </Button>
            <Button
              variant="primary"
              fullWidth
              className="sm:w-auto"
              onClick={handleSave}
              isLoading={saving || savingUser}
            >
              Save changes
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-overline font-semibold uppercase tracking-wide text-text-subtle">
        {label}
      </span>
      {children}
    </div>
  )
}
