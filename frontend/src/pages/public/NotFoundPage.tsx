import { useNavigate } from 'react-router'
import { Button } from '@/components/ui'
import unsetTable from '@/assets/unset-table.svg'

// 404 — "This table isn't set". Mirrors the Figma wireframe (node 907:123): a
// centered stack of the unset-table illustration, a big orange "404", a bold
// heading, and muted body copy. The wireframe reserves space below the copy for a
// way out, so we add the standard dark primary CTA back to the landing page.
//
// A field of soft "bubbles" drifts up behind the content for ambient life. It
// uses the `bubble-rise` CSS keyframe (index.css) with a NEGATIVE animation-delay
// per bubble, so every bubble starts already mid-flight — the field is full from
// first paint and the loop is seamless. Reduced motion freezes it (CSS backstop).

// Bubble specs: percent-based x, px size, loop duration, and a NEGATIVE start
// offset (seconds into the loop each begins) so they're spread along the column
// from frame one instead of all launching from the bottom together.
const BUBBLES = [
  { left: '8%', size: 54, duration: 13, offset: -2 },
  { left: '20%', size: 30, duration: 10, offset: -7 },
  { left: '34%', size: 72, duration: 16, offset: -11 },
  { left: '48%', size: 22, duration: 9, offset: -4 },
  { left: '62%', size: 46, duration: 12, offset: -9 },
  { left: '76%', size: 34, duration: 11, offset: -1 },
  { left: '88%', size: 60, duration: 15, offset: -6 },
] as const

export function NotFoundPage() {
  const navigate = useNavigate()

  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-surface-raised px-6 py-16 text-center">
      {/* Ambient rising bubbles — behind content, non-interactive. */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
        {BUBBLES.map((b, i) => (
          <span
            key={i}
            className="absolute rounded-pill bg-primary/25 ring-1 ring-primary/30"
            style={{
              left: b.left,
              width: b.size,
              height: b.size,
              bottom: -b.size,
              animation: `bubble-rise ${b.duration}s ease-in-out ${b.offset}s infinite`,
            }}
          />
        ))}
      </div>

      {/* Content sits above the bubble layer. */}
      <div className="relative flex flex-col items-center">
        <img src={unsetTable} alt="" className="h-[120px] w-[140px]" />

        <p className="mt-5 font-display text-[96px] font-extrabold leading-none text-primary">404</p>

        <h1 className="mt-2 font-display text-display font-bold text-text">
          This table isn&rsquo;t set
        </h1>

        <p className="mt-2.5 max-w-[420px] text-body leading-relaxed text-text-muted">
          We couldn&rsquo;t find the page you were looking for. It may have moved, or the link might
          be out of date.
        </p>

        <Button className="mt-7" onClick={() => navigate('/')}>
          Back to home
        </Button>
      </div>
    </main>
  )
}
