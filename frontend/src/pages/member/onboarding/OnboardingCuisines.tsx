import { useNavigate } from 'react-router'
import { Button, Icon } from '@/components/ui'
import { CuisineTriStatePicker } from '@/components/profile/CuisineTriStatePicker'
import { useProfileStore } from '@/stores/profileStore'

// Onboarding step 2 of 4 content — like/avoid cuisines in a single tri-state
// step. Each chip cycles neutral → like → avoid → neutral, so a cuisine can never
// be both. Writes through setCuisineState (preferred/disliked kept mutually
// exclusive). Rendered inside AuthFlowShell (which owns the layout + slide).
export function CuisinesStep() {
  const navigate = useNavigate()
  const preferred = useProfileStore((s) => s.profile?.preferred_cuisines ?? [])
  const disliked = useProfileStore((s) => s.profile?.disliked_cuisines ?? [])
  const setCuisineState = useProfileStore((s) => s.setCuisineState)

  return (
    <>
      <CuisineTriStatePicker liked={preferred} disliked={disliked} onCycle={setCuisineState} />

      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          leftIcon={<Icon name="arrow-left" size={14} />}
          onClick={() => navigate('/onboarding/dietary')}
        >
          Back
        </Button>
        <Button variant="primary" fullWidth onClick={() => navigate('/onboarding/budget')}>
          Continue
        </Button>
        <Button variant="ghost" onClick={() => navigate('/onboarding/budget')}>
          Skip
        </Button>
      </div>
    </>
  )
}
