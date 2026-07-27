import { useNavigate } from 'react-router'
import { Button, Chip } from '@/components/ui'
import { DIETARY_RESTRICTIONS, isAllergen } from '@/constants/dietary'
import { useProfileStore } from '@/stores/profileStore'
import { useEffect } from 'react'

// Split the controlled dietary vocabulary into the wireframe's two groups:
// lifestyle/religious diets vs. allergen "free-from" presets. Both persist to
// profile.dietary_restrictions.
const DIET_OPTIONS = DIETARY_RESTRICTIONS.filter((o) => !isAllergen(o.value))
const ALLERGEN_OPTIONS = DIETARY_RESTRICTIONS.filter((o) => isAllergen(o.value))

// Onboarding step 1 content (dietary needs). Rendered inside AuthFlowShell,
// which owns the brand panel, progress ticks, title/subtitle, and the slide
// transition — this component is just the right-panel form + footer.
export function DietaryStep() {
  const navigate = useNavigate()
  const profile = useProfileStore((s) => s.profile)
  const load = useProfileStore((s) => s.load)
  const dietary = profile?.dietary_restrictions ?? []
  const toggleDietary = useProfileStore((s) => s.toggleDietary)

  useEffect(() => {
    if (!profile) void load()
  }, [profile, load])

  return (
    <>
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

      <div className="flex flex-col gap-2">
        <span className="text-overline font-semibold uppercase tracking-wide text-text-muted">
          Allergies
        </span>
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
      </div>

      <div className="flex items-center gap-2">
        <Button variant="primary" fullWidth onClick={() => navigate('/onboarding/cuisines')}>
          Continue
        </Button>
        <Button variant="ghost" onClick={() => navigate('/onboarding/cuisines')}>
          Skip
        </Button>
      </div>
    </>
  )
}
