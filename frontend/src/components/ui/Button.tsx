import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '@/utils/cn'
import { Spinner } from './Spinner'

type ButtonVariant = 'primary' | 'accent' | 'secondary' | 'ghost' | 'danger'
type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  isLoading?: boolean
  fullWidth?: boolean
  leftIcon?: ReactNode
  rightIcon?: ReactNode
}

// Visual decisions live here, not scattered in JSX. Semantic tokens only.
// The wireframe uses DARK cocoa for primary CTAs; orange is an accent.
const variantClasses: Record<ButtonVariant, string> = {
  primary: 'bg-surface-inverse text-white hover:opacity-90',
  accent: 'bg-primary text-on-primary hover:bg-primary-hover',
  secondary: 'bg-primary text-on-primary hover:bg-primary-hover',
  ghost: 'bg-transparent text-text hover:bg-surface-sunken',
  danger: 'bg-error text-on-primary hover:opacity-90',
}

// Heights stay bespoke (touch targets); the LABEL sizes come off the type scale so
// a button's text matches the copy around it. md was `text-base` (16px) — the one
// off-scale size in the app, which read a step larger than every adjacent label.
const sizeClasses: Record<ButtonSize, string> = {
  sm: 'h-9 px-3 text-caption gap-1.5',
  md: 'h-11 px-4 text-body gap-2',
  lg: 'h-13 px-6 text-item-title gap-2.5',
}

export function Button({
  variant = 'primary',
  size = 'md',
  isLoading = false,
  fullWidth = false,
  leftIcon,
  rightIcon,
  disabled,
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center rounded-input font-sans font-medium',
        'transition-[color,background-color,border-color,opacity,transform] duration-150 ease-out',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring',
        // Tactile press feedback (motion-safe only). Disabled buttons stay put.
        'active:brightness-95 disabled:active:brightness-100',
        'motion-safe:active:scale-[0.97] disabled:motion-safe:active:scale-100',
        'disabled:cursor-not-allowed disabled:opacity-50',
        variantClasses[variant],
        sizeClasses[size],
        fullWidth && 'w-full',
        className,
      )}
      disabled={disabled || isLoading}
      {...props}
    >
      {isLoading ? <Spinner size="sm" /> : leftIcon}
      {children}
      {!isLoading && rightIcon}
    </button>
  )
}
