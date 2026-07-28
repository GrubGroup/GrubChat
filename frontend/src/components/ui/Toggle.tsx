import { useId } from 'react'
import { cn } from '@/utils/cn'

export interface ToggleProps {
  checked: boolean
  onChange: (value: boolean) => void
  label?: string
  disabled?: boolean
  className?: string
}

export function Toggle({ checked, onChange, label, disabled = false, className }: ToggleProps) {
  const id = useId()
  return (
    <div className={cn('flex items-center gap-3', className)}>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative inline-flex h-6 w-11 shrink-0 items-center rounded-pill transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring',
          'disabled:cursor-not-allowed disabled:opacity-50',
          checked ? 'bg-primary' : 'bg-border-strong',
        )}
      >
        <span
          className={cn(
            'inline-block h-5 w-5 transform rounded-pill bg-surface-raised transition-transform',
            checked ? 'translate-x-5' : 'translate-x-0.5',
          )}
        />
      </button>
      {label && (
        <label htmlFor={id} className="text-body text-text">
          {label}
        </label>
      )}
    </div>
  )
}
