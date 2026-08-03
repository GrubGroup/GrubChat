import { useNavigate } from 'react-router'
import { Button, Icon } from '@/components/ui'
import { useProfileStore } from '@/stores/profileStore'
import { cn } from '@/utils/cn'

// A budget is a CEILING, so `max` is what the recommendation reads. "Flexible"
// stores the NO_CAP sentinel (max 0 — see @/utils/formatBudget), NOT a wide
// range: it used to be { 0, 200 }, which is indistinguishable from "$40+" at the
// point where the group picks are ranked, so choosing "Flexible" made someone
// look like a $200-a-head diner and dragged the whole group's picks upmarket.
// Kept in sync with ProfileEditPage's BUDGET_BANDS.
const BANDS = [
  { label: 'Under $15', min: 0, max: 15 },
  { label: '$15–25', min: 15, max: 25 },
  { label: '$25–40', min: 25, max: 40 },
  { label: '$40+', min: 40, max: 200 },
  { label: 'Flexible', min: 0, max: 0 },
]

// Onboarding step 3 of 4 content (usual budget). Rendered inside AuthFlowShell.
export function BudgetStep() {
  const navigate = useNavigate()
  const budgetMin = useProfileStore((s) => s.profile?.budget_min ?? 15)
  const budgetMax = useProfileStore((s) => s.profile?.budget_max ?? 25)
  const setBudget = useProfileStore((s) => s.setBudget)

  return (
    <>
      <div className="flex flex-col gap-2">
        {BANDS.map((b) => {
          const selected = b.min === budgetMin && b.max === budgetMax
          return (
            <button
              key={b.label}
              onClick={() => setBudget(b.min, b.max)}
              className={cn(
                'flex h-12 items-center justify-between rounded-input border px-4 text-left transition-colors',
                selected
                  ? 'border-text bg-surface-inverse text-on-inverse'
                  : 'border-border bg-surface-sunken text-text hover:border-border-strong',
              )}
            >
              <span className="font-medium">{b.label}</span>
              {selected && <Icon name="check" size={14} />}
            </button>
          )
        })}
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          leftIcon={<Icon name="arrow-left" size={14} />}
          onClick={() => navigate('/onboarding/cuisines')}
        >
          Back
        </Button>
        <Button variant="primary" fullWidth onClick={() => navigate('/onboarding/location')}>
          Continue
        </Button>
      </div>
    </>
  )
}
