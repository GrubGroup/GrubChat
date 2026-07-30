import { cn } from '@/utils/cn'

type ProgressTone = 'primary' | 'success'

export interface ProgressBarProps {
  value: number
  total: number
  label?: string
  tone?: ProgressTone
  className?: string
}

const toneClasses: Record<ProgressTone, string> = {
  primary: 'bg-primary',
  success: 'bg-success',
}

export function ProgressBar({
  value,
  total,
  label,
  tone = 'primary',
  className,
}: ProgressBarProps) {
  const pct = total > 0 ? Math.min(100, Math.max(0, (value / total) * 100)) : 0
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && (
        <div className="flex items-center justify-between text-body text-text-muted">
          <span>{label}</span>
          <span>
            {value} / {total}
          </span>
        </div>
      )}
      <div
        role="progressbar"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={total}
        className="h-2 w-full overflow-hidden rounded-pill bg-surface-sunken"
      >
        <div
          className={cn('h-full rounded-pill transition-all', toneClasses[tone])}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}
