import { useId } from 'react'
import { cn } from '@/utils/cn'

export interface MicPopProps {
  size?: number
  className?: string
  // Resting mic color. Defaults to inheriting the parent button's own on-fill
  // token, which is correct for every variant.
  restClass?: string
  // Color the whole glyph tints to on the parent button's hover (default orange
  // `group-hover:text-primary-text`). On an orange button, override so it stays visible.
  hoverClass?: string
}

// Animated mic affordance for the "Start a session" CTA. At rest it's just the
// white mic outline (as before). On the PARENT button's hover:
//   - the whole glyph tints orange (currentColor → primary),
//   - two concentric "( ))" rings radiate outward in the background, and
//   - an orange "liquid" fill RISES up inside the mic silhouette with a rippling
//     wave surface (a partial, filling-up look — not a hard full fill).
//
// Driven by CSS `group-hover` (the button must carry the `group` class) since the
// hover target is the parent button, not this element. All motion routes through
// classes in index.css (`.animate-wave`, `.mic-fill`, `.mic-fill-wave`), so the
// global prefers-reduced-motion backstop tames it for users who opt out. Color
// flows from `currentColor`: the container is white and turns primary on hover,
// so rings, outline, and fill all follow.
export function MicPop({
  size = 18,
  className,
  restClass = 'text-current',
  hoverClass = 'group-hover:text-primary-text',
}: MicPopProps) {
  // Unique, selector-safe clip id (useId embeds colons — strip them).
  const clipId = `mic-clip-${useId().replace(/:/g, '')}`

  return (
    <span
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center transition-colors',
        restClass,
        hoverClass,
        className,
      )}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {/* Radiating rings — hidden at rest, pulse outward on hover (motion-safe). */}
      <span className="pointer-events-none absolute inset-0 rounded-pill border border-current opacity-0 motion-safe:group-hover:animate-wave" />
      <span
        className="pointer-events-none absolute inset-0 rounded-pill border border-current opacity-0 motion-safe:group-hover:animate-wave"
        style={{ animationDelay: '0.7s' }}
      />

      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        className="relative"
      >
        <defs>
          {/* Solid mic silhouette — clips the rising liquid to the mic shape. */}
          <clipPath id={clipId}>
            <rect x="9" y="2" width="6" height="12" rx="3" />
            <path d="M5 10v1a7 7 0 0 0 6 6.93V21H8.5a1 1 0 0 0 0 2h7a1 1 0 0 0 0-2H13v-3.07A7 7 0 0 0 19 11v-1a1 1 0 0 0-2 0v1a5 5 0 0 1-10 0v-1a1 1 0 0 0-2 0Z" />
          </clipPath>
        </defs>

        {/* Liquid fill: rests low, rises on hover; the wave path ripples sideways.
            Nested groups keep the rise (translateY) and ripple (translateX) from
            clobbering each other. */}
        <g clipPath={`url(#${clipId})`}>
          <g className="mic-fill">
            <path
              className="mic-fill-wave"
              fill="currentColor"
              fillOpacity={0.9}
              d="M-12 12 q3 -2 6 0 t6 0 t6 0 t6 0 t6 0 t6 0 t6 0 t6 0 t6 0 V30 H-12 Z"
            />
          </g>
        </g>

        {/* Mic outline on top. */}
        <g
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
          <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
          <path d="M12 18v4M8 22h8" />
        </g>
      </svg>
    </span>
  )
}
