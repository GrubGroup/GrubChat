import type { InputHTMLAttributes, Ref, ReactNode } from 'react'
import { useId, useState } from 'react'
import { cn } from '@/utils/cn'
import { Icon } from './Icon'

type InputSize = 'sm' | 'md'

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
  hint?: ReactNode
  leftIcon?: ReactNode
  /** Field height + text size. 'md' (default) keeps the standard 44px form field;
   * 'sm' is a compact 36px / 14px bar for inline search. */
  inputSize?: InputSize
  /** Forwarded to the <input> itself, so popovers anchor to the field and not
   * to the wrapper (whose height changes when the error/hint line appears). */
  ref?: Ref<HTMLInputElement>
}

// `cn` doesn't tailwind-merge, so height/text come from this map (never a
// hardcoded h-11) to keep overrides predictable.
const sizeClasses: Record<InputSize, string> = {
  md: 'h-11',
  sm: 'h-9 text-body',
}

export function Input({
  label,
  error,
  hint,
  leftIcon,
  inputSize = 'md',
  className,
  id,
  type,
  ref,
  ...props
}: InputProps) {
  const autoId = useId()
  const inputId = id ?? autoId
  const msgId = `${inputId}-msg`

  // Password fields get a built-in show/hide toggle. When revealed we swap the
  // native type to "text" so the value is visible; the eye button sits at the
  // right edge (mirroring an optional leftIcon), so reserve right padding for it.
  const isPassword = type === 'password'
  const [revealed, setRevealed] = useState(false)
  const resolvedType = isPassword && revealed ? 'text' : type

  return (
    <div className="flex w-full flex-col gap-1.5">
      {label && (
        <label htmlFor={inputId} className="text-body font-medium text-text">
          {label}
        </label>
      )}
      <div className="relative">
        {leftIcon && (
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted">
            {leftIcon}
          </span>
        )}
        <input
          id={inputId}
          type={resolvedType}
          ref={ref}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || hint ? msgId : undefined}
          className={cn(
            'w-full rounded-input border bg-surface-sunken px-3 text-text',
            sizeClasses[inputSize],
            'placeholder:text-text-muted/75',
            'focus:outline-none focus:ring-2 focus:ring-focus-ring',
            'disabled:cursor-not-allowed disabled:opacity-50',
            Boolean(leftIcon) && 'pl-10',
            isPassword && 'pr-10',
            error ? 'border-error' : 'border-border',
            className,
          )}
          {...props}
        />
        {isPassword && (
          <button
            type="button"
            // Purely visual toggle — keep it out of the tab order so it doesn't
            // sit between the password field and the submit button.
            tabIndex={-1}
            onClick={() => setRevealed((v) => !v)}
            aria-label={revealed ? 'Hide password' : 'Show password'}
            aria-pressed={revealed}
            className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center justify-center rounded-md p-1.5 text-text-muted hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            <Icon name={revealed ? 'eye-off' : 'eye'} size={18} />
          </button>
        )}
      </div>
      {error ? (
        <p id={msgId} role="alert" className="text-body text-error-text">
          {error}
        </p>
      ) : hint ? (
        <p id={msgId} className="text-body text-text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  )
}
