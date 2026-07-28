import type { TextareaHTMLAttributes } from 'react'
import { useId } from 'react'
import { cn } from '@/utils/cn'

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string
  error?: string
  hint?: string
}

export function Textarea({ label, error, hint, className, id, rows = 3, ...props }: TextareaProps) {
  const autoId = useId()
  const textareaId = id ?? autoId

  return (
    <div className="flex w-full flex-col gap-1.5">
      {label && (
        <label htmlFor={textareaId} className="text-body font-medium text-text">
          {label}
        </label>
      )}
      <textarea
        id={textareaId}
        rows={rows}
        aria-invalid={error ? true : undefined}
        className={cn(
          'w-full rounded-input border bg-surface-sunken px-3 py-2 text-text',
          'placeholder:text-text-muted/60',
          'focus:outline-none focus:ring-2 focus:ring-focus-ring',
          'disabled:cursor-not-allowed disabled:opacity-50',
          error ? 'border-error' : 'border-border',
          className,
        )}
        {...props}
      />
      {error ? (
        <p className="text-body text-error">{error}</p>
      ) : hint ? (
        <p className="text-body text-text-muted">{hint}</p>
      ) : null}
    </div>
  )
}
