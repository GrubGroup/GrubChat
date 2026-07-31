import type { SVGProps } from 'react'

// Line-style icons (Lucide-derived paths, MIT) matching the wireframe's stroke
// aesthetic. Single component so icons are consistent and swappable. Size via
// the `size` prop; color inherits `currentColor`.
export type IconName =
  | 'mic'
  | 'mic-off'
  | 'square'
  | 'send'
  | 'plus'
  | 'check'
  | 'circle'
  | 'x'
  | 'lock'
  | 'chevron-left'
  | 'chevron-up'
  | 'chevron-down'
  | 'menu'
  | 'dots'
  | 'arrow-left'
  | 'arrow-right'
  | 'utensils'
  | 'users'
  | 'calendar'
  | 'clock'
  | 'message'
  | 'sparkles'
  | 'map-pin'
  | 'wallet'
  | 'star'
  | 'search'
  | 'bell'
  | 'party'
  | 'logout'
  | 'pencil'
  | 'heart'
  | 'settings'
  | 'user'
  | 'speaker'
  | 'sun'
  | 'moon'
  | 'monitor'

const PATHS: Record<IconName, ReactSvgContent> = {
  mic: (
    <>
      <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
      <path d="M12 18v4M8 22h8" />
    </>
  ),
  // Slashed mic — the mute affordance. Drawn as an outline (no filled variant); a
  // diagonal cut across the mic reads as "muted" regardless of fill.
  'mic-off': (
    <>
      <path d="M2 2 22 22" />
      <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" />
      <path d="M5 10v2a7 7 0 0 0 12 5" />
      <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" />
      <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
      <path d="M12 18v4M8 22h8" />
    </>
  ),
  // Stop glyph — a rounded square filling most of the viewBox (Lucide's stop
  // proportions) so it reads as a solid "stop recording" block, not a small dot.
  // The closed rect fills cleanly, so no purpose-built FILLED_PATHS entry is needed.
  square: <rect x="5" y="5" width="14" height="14" rx="3" />,
  send: (
    <>
      <path d="m22 2-7 20-4-9-9-4Z" />
      <path d="M22 2 11 13" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="M20 6 9 17l-5-5" />,
  circle: <circle cx="12" cy="12" r="9" />,
  x: <path d="M18 6 6 18M6 6l12 12" />,
  lock: (
    <>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </>
  ),
  'chevron-left': <path d="m15 18-6-6 6-6" />,
  'chevron-up': <path d="m18 15-6-6-6 6" />,
  'chevron-down': <path d="m6 9 6 6 6-6" />,
  // Hamburger.
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  // Horizontal ellipsis — the mobile overflow menu. Dots are filled discs (a
  // 1px-radius stroked circle renders as a hairline ring, not a dot).
  dots: (
    <>
      <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  'arrow-left': (
    <>
      <path d="M19 12H5" />
      <path d="m12 19-7-7 7-7" />
    </>
  ),
  'arrow-right': (
    <>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </>
  ),
  utensils: (
    <>
      <path d="M3 2v7c0 1.1.9 2 2 2h0a2 2 0 0 0 2-2V2M5 2v20" />
      <path d="M17 2v20M17 12h4c0-4-1-7-4-8Z" />
    </>
  ),
  users: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </>
  ),
  // Clock face — the duration / answer-window affordance. r=9 matches this
  // file's `circle` (not Lucide's r=10) so a 2px stroke doesn't crowd the 24px
  // box; the hands are one polyline — minute up, hour to ~2 o'clock — i.e.
  // Lucide's 12 6 / 12 12 / 16 14 scaled 0.9 about the centre to clean
  // coordinates, so the tips land 5 and 4.03 units out, inside the dial.
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  message: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />,
  sparkles: (
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.4 2.4M15.3 15.3l2.4 2.4M17.7 6.3l-2.4 2.4M8.7 15.3l-2.4 2.4" />
  ),
  'map-pin': (
    <>
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
      <circle cx="12" cy="10" r="3" />
    </>
  ),
  wallet: (
    <>
      <path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2" />
      <path d="M21 7H7a2 2 0 0 0 0 4h14" />
      <circle cx="16" cy="13" r="1" />
    </>
  ),
  star: <path d="M12 2 15 9l7 .5-5.5 4.5L18 21l-6-3.5L6 21l1.5-7L2 9.5 9 9Z" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </>
  ),
  bell: (
    <>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </>
  ),
  party: (
    <>
      <path d="M5.8 11.3 2 22l10.7-3.8" />
      <path d="M4 3h.01M22 8h.01M15 2h.01M22 20h.01" />
      <path d="M11 13a9 9 0 0 1 8-8M19 5a9 9 0 0 1-8 8" />
    </>
  ),
  logout: (
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </>
  ),
  pencil: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </>
  ),
  heart: (
    <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.29 1.51 4.04 3 5.5l7 7Z" />
  ),
  settings: (
    <>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  user: (
    <>
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </>
  ),
  // Speaker emitting sound waves — the "voice / speaking" affordance for the AI
  // voice setting. A speaker cone (box + triangular horn) plus two arced waves.
  speaker: (
    <>
      <path d="M11 5 6 9H2v6h4l5 4Z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M19 5a9 9 0 0 1 0 14" />
    </>
  ),
  // Sun — the "Light" theme segment. A disc plus eight radiating rays.
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  // Crescent moon — the "Dark" theme segment.
  moon: <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />,
  // Desktop monitor — the "System" theme segment (follow OS setting).
  monitor: (
    <>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </>
  ),
}

// A few icons only make sense as a clean SOLID glyph when `filled` (their stroke
// paths have open arcs/ticks that auto-close into artifacts under fill). Provide
// purpose-built filled variants for those; everything else just fills its stroke
// path. Needed by the tab/rail icons (users, calendar, user) and the mic.
const FILLED_PATHS: Partial<Record<IconName, ReactSvgContent>> = {
  // Solid mic: filled capsule head + a solid "cradle" wedge (the u-shaped stand
  // ring, drawn as a closed shape so no open arc self-intersects) + a short
  // filled stem/base. Built purpose-first so the outline's open base tick
  // (M12 18v4M8 22h8) doesn't auto-close into artifacts under fill.
  mic: (
    <>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10v1a7 7 0 0 0 6 6.93V21H8.5a1 1 0 0 0 0 2h7a1 1 0 0 0 0-2H13v-3.07A7 7 0 0 0 19 11v-1a1 1 0 0 0-2 0v1a5 5 0 0 1-10 0v-1a1 1 0 0 0-2 0Z" />
    </>
  ),
  users: (
    // Back person drawn FIRST (behind), its body sharing the SAME y=21 baseline
    // as the front person so no corner protrudes; the front body then covers the
    // seam, leaving a clean shoulder peeking on the right.
    <>
      <circle cx="17" cy="7" r="3.5" />
      <path d="M16 14h2a4 4 0 0 1 4 4v2a1 1 0 0 1-1 1h-4Z" />
      <circle cx="9" cy="7" r="4" />
      <path d="M15 14H6a4 4 0 0 0-4 4v2a1 1 0 0 0 1 1h15a1 1 0 0 0 1-1v-2a4 4 0 0 0-4-4Z" />
    </>
  ),
  calendar: (
    <>
      <path d="M8 2a1 1 0 0 0-1 1v1H6a3 3 0 0 0-3 3v1h18V7a3 3 0 0 0-3-3h-1V3a1 1 0 1 0-2 0v1H9V3a1 1 0 0 0-1-1Z" />
      <path d="M3 10v8a3 3 0 0 0 3 3h12a3 3 0 0 0 3-3v-8H3Z" />
    </>
  ),
  // Solid magnifying glass — the active Explore tab. The outline's lens is an open
  // ring and its handle a zero-area line, both of which collapse under fill (a blob
  // lens + a vanished handle), so provide a purpose-built glyph: a lens RING (outer
  // + inner circle in one evenodd path so the center is a hole, not a blob) plus a
  // solid rounded handle on the 45° diagonal. Mirrors the users/calendar treatment.
  search: (
    <>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M11 3.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 1 0 0-15Zm0 3a4.5 4.5 0 1 0 0 9 4.5 4.5 0 1 0 0-9Z"
      />
      <rect x="17" y="14.7" width="3" height="7.6" rx="1.5" transform="rotate(-45 18.5 18.5)" />
    </>
  ),
  // Solid single person — the active Profile tab. Head + a closed shoulders
  // shape on the same y=21 baseline (the outline's open "M19 21v-2" arc would
  // auto-close into a wedge under fill).
  user: (
    <>
      <circle cx="12" cy="7" r="4.5" />
      <path d="M9 13h6a5 5 0 0 1 5 5v2a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-2a5 5 0 0 1 5-5Z" />
    </>
  ),
}

type ReactSvgContent = React.ReactNode

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName
  size?: number
  filled?: boolean
}

export function Icon({ name, size = 16, filled = false, ...props }: IconProps) {
  // Prefer a purpose-built solid glyph when filling an icon that has one.
  const content = filled ? (FILLED_PATHS[name] ?? PATHS[name]) : PATHS[name]
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {content}
    </svg>
  )
}
