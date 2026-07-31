import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '@/utils/cn'

type IconButtonVariant = 'primary' | 'accent' | 'secondary' | 'ghost' | 'danger'
type IconButtonSize = 'sm' | 'md' | 'lg'

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> {
  icon: ReactNode
  label: string // required — enforces accessible name
  variant?: IconButtonVariant
  size?: IconButtonSize
}

// primary: hairline border delineates the raised near-black CTA against the
// warm ink page in dark mode (negligible on light); text-on-inverse over raw white
// keeps it token-pure. Matches Button.tsx.
const variantClasses: Record<IconButtonVariant, string> = {
  primary: 'border border-border-strong bg-surface-inverse text-on-inverse hover:opacity-90',
  accent: 'bg-primary text-on-primary hover:bg-primary-hover',
  secondary: 'bg-primary text-on-primary hover:bg-primary-hover',
  ghost: 'bg-transparent text-text-muted hover:bg-surface-sunken',
  danger: 'bg-error text-on-error hover:opacity-90',
}

const sizeClasses: Record<IconButtonSize, string> = {
  sm: 'h-9 w-9',
  md: 'h-11 w-11',
  lg: 'h-13 w-13',
}

export function IconButton({
  icon,
  label,
  variant = 'ghost',
  size = 'md',
  className,
  ...props
}: IconButtonProps) {
  return (
    <button
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex items-center justify-center rounded-pill transition-[color,background-color,transform] duration-150 ease-out',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring',
        'motion-safe:active:scale-[0.92] disabled:motion-safe:active:scale-100',
        'disabled:cursor-not-allowed disabled:opacity-50',
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      {...props}
    >
      {icon}
    </button>
  )
}
