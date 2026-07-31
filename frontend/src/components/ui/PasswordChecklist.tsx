import { PASSWORD_RULES } from '@/utils/password'
import { Icon } from './Icon'
import { cn } from '@/utils/cn'

export interface PasswordChecklistProps {
  /** The current password value being validated. */
  value: string
  className?: string
}

// Live requirement checklist shown beneath a new-password field. Each rule turns
// from muted to success as the typed value satisfies it, guiding the user to a
// valid password before they submit. Rules come from the shared PASSWORD_RULES so
// this stays in lockstep with the validation gate.
export function PasswordChecklist({ value, className }: PasswordChecklistProps) {
  return (
    <ul className={cn('flex flex-col gap-1', className)}>
      {PASSWORD_RULES.map((rule) => {
        const passed = rule.test(value)
        return (
          <li
            key={rule.key}
            className={cn(
              'flex items-center gap-1.5 text-caption',
              passed ? 'text-success' : 'text-text-muted',
            )}
          >
            <Icon name={passed ? 'check' : 'circle'} size={13} />
            {rule.label}
          </li>
        )
      })}
    </ul>
  )
}
