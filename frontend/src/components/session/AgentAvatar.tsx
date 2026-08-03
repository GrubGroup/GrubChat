import { cn } from '@/utils/cn'

// The food agent's identity avatar for one-on-one chat — replaces the old 🍽
// emoji chip. A rounded gradient tile (the terracotta→primary brand gradient
// used on restaurant cards) holding a single-stroke "AI dish" glyph: a serving
// dome over a plate line, topped with a sparkle to read as *assistant*, not just
// *food*. Drawn in `currentColor` at a fixed 24-unit viewBox and scaled by
// `size`, so it stays crisp at every use (20px inline header → 64px loader).
//
// Presentational only. The gradient + sparkle make it unmistakably the agent
// next to human (initials) avatars, without leaning on an emoji.
export interface AgentAvatarProps {
  /** Tile edge length in px. Inline chat headers use ~20–24; larger for heroes. */
  size?: number
  className?: string
}

export function AgentAvatar({ size = 24, className }: AgentAvatarProps) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-pill bg-gradient-to-br from-member-terracotta to-primary text-on-inverse shadow-sm',
        className,
      )}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg
        width={size * 0.62}
        height={size * 0.62}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.9}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* serving dome + plate line — the "dish" */}
        <path d="M4 16h16" />
        <path d="M5.5 16a6.5 6.5 0 0 1 13 0" />
        <path d="M12 9.5V8" />
        {/* sparkle — the "AI" tell, top-right */}
        <path d="M18.5 3.5v3M17 5h3" fill="none" />
      </svg>
    </span>
  )
}
