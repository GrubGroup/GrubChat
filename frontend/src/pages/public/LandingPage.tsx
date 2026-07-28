import { useRef, type ReactNode } from 'react'
import { motion, useReducedMotion, useScroll, useTransform, type MotionValue } from 'framer-motion'
import { Button, Icon, MicPop, Wordmark, type IconName } from '@/components/ui'
import { EASE, viewport, useFadeUp, makeFloat } from '@/lib/motion'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { useNavigate } from 'react-router'
import { cn } from '@/utils/cn'

// Public marketing landing page — the logged-out entry. Follows the "Warm
// Flagship" Figma frame (node 725-254): warm sand/white surfaces, dark cocoa
// CTAs, orange as an accent, layered dimensional hero, one dark "product in use"
// band for rhythm. Purely presentational: Sign in → existing sign-in page,
// Start a session → existing sign-up page. No auth/behavior changes.

// Motion vocabulary (EASE, viewport, useFadeUp, makeFloat) lives in @/lib/motion
// and is shared with the auth/onboarding brand panel. useFadeUp() is
// reduced-motion aware (drops the rise when the user prefers reduced motion).

// Smooth-scroll to a section by id (honors reduced-motion via the global
// scroll-behavior guard in index.css). Shared by the nav + in-page links.
const scrollToId = (id: string) =>
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })

// Member-identity avatar dot (literal bg classes so Tailwind v4 sees them).
const MEMBER_BG = [
  'bg-member-purple',
  'bg-member-pink',
  'bg-member-terracotta',
  'bg-member-green',
  'bg-member-blue',
  'bg-member-amber',
] as const

function MemberDot({
  i,
  initials,
  size = 28,
  ring = 'ring-surface',
}: {
  i: number
  initials?: string
  size?: number
  ring?: string
}) {
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-pill font-semibold text-white ring-2',
        MEMBER_BG[i % MEMBER_BG.length],
        ring,
      )}
      style={{ width: size, height: size, fontSize: size * 0.34 }}
    >
      {initials}
    </span>
  )
}

// ---------------------------------------------------------------------------
export function LandingPage() {
  const navigate = useNavigate()
  const reduce = useReducedMotion()

  // Sign in → existing sign-in page. Start a session → existing sign-up page.
  const toSignIn = () => navigate('/login')
  const toSignUp = () => navigate('/signup')

  // Gentle infinite float for the hero's layered panels (disabled if reduced).
  const float = makeFloat(!!reduce)

  return (
    <div className="min-h-screen overflow-x-clip bg-surface font-sans text-text">
      <Nav toSignIn={toSignIn} toSignUp={toSignUp} />
      <Hero toSignUp={toSignUp} float={float} reduce={!!reduce} />
      <SocialBand />
      <HowItWorks />
      <FeatureShowcase />
      <ProductInUse />
      <EmotionalBenefit />
      <FinalCta toSignUp={toSignUp} />
      <Footer />
    </div>
  )
}

// ---------------------------------------------------------------------------
// §1 Nav
function Nav({ toSignIn, toSignUp }: { toSignIn: () => void; toSignUp: () => void }) {
  const links: { label: string; target: string }[] = [
    { label: 'How it works', target: 'how-it-works' },
    { label: 'Features', target: 'features' },
    { label: 'Discover', target: 'discover' },
  ]
  return (
    <motion.header
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: EASE }}
      className="sticky top-0 z-50 border-b border-border/60 bg-surface/80 backdrop-blur-md"
    >
      <nav className="mx-auto flex h-[72px] max-w-[1200px] items-center justify-between px-6 lg:px-8">
        <Wordmark />
        <div className="hidden items-center gap-8 md:flex">
          {links.map((l) => (
            <button
              key={l.target}
              onClick={() => scrollToId(l.target)}
              className="text-[15px] font-medium text-text/80 transition-colors hover:text-text"
            >
              {l.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-4">
          <button
            onClick={toSignIn}
            className="text-[15px] font-semibold text-text transition-colors hover:text-primary"
          >
            Sign in
          </button>
          <Button
            variant="primary"
            onClick={toSignUp}
            leftIcon={<MicPop size={16} />}
            className="group rounded-pill"
          >
            Start a session
          </Button>
        </div>
      </nav>
    </motion.header>
  )
}

// ---------------------------------------------------------------------------
// §2 Hero — layered dimensional cluster
function Hero({
  toSignUp,
  float,
  reduce,
}: {
  toSignUp: () => void
  float: (delay: number, dist?: number) => object
  reduce: boolean
}) {
  const fadeUp = useFadeUp()
  return (
    // Fills exactly one viewport (nav is 72px sticky) so a full-screen visitor
    // sees only the hero, with the scroll cue pinned to the bottom.
    <section className="relative mx-auto flex min-h-[calc(100dvh-72px)] max-w-[1200px] flex-col px-6 pb-6 pt-8 lg:px-8">
      <div className="flex flex-1 items-center">
        <div className="grid w-full items-center gap-12 lg:grid-cols-2 lg:gap-8">
        {/* Left — copy */}
        <motion.div
          initial="hidden"
          animate="show"
          variants={{ show: { transition: { staggerChildren: 0.09 } } }}
          className="flex flex-col items-center text-center lg:items-start lg:text-left"
        >
          <motion.span
            variants={fadeUp}
            className="inline-flex items-center gap-2 rounded-pill border border-primary/30 bg-surface-panel px-3 py-1.5"
          >
            <span className="h-1.5 w-1.5 rounded-pill bg-primary" />
            <span className="text-[12px] font-semibold tracking-wide text-primary">
              VOICE-FIRST GROUP DINING
            </span>
          </motion.span>

          <motion.h1
            variants={fadeUp}
            className="mt-6 font-display text-[44px] font-extrabold leading-[1.02] tracking-tight sm:text-[64px]"
          >
            The restaurant <span className="text-primary">everyone</span> agrees on.
          </motion.h1>

          <motion.p
            variants={fadeUp}
            className="mt-5 max-w-md text-[17px] leading-relaxed text-text-muted sm:text-[19px]"
          >
            Every person talks to their own AI agent. One result that works for the whole group.
          </motion.p>

          <motion.div variants={fadeUp} className="mt-8 flex flex-wrap items-center justify-center gap-4 lg:justify-start">
            <Button
              variant="primary"
              size="lg"
              onClick={toSignUp}
              leftIcon={<MicPop size={18} />}
              className="group rounded-pill"
            >
              Start a session
            </Button>
            <Button
              variant="ghost"
              size="lg"
              onClick={() => scrollToId('how-it-works')}
              rightIcon={<Icon name="arrow-right" size={18} />}
              className="rounded-pill border border-border-strong"
            >
              See how it works
            </Button>
          </motion.div>

          <motion.div variants={fadeUp} className="mt-8 flex items-center gap-3.5">
            <div className="flex -space-x-2.5">
              {['MA', 'PR', 'TO', 'DE'].map((n, i) => (
                <MemberDot key={n} i={i} initials={n} size={34} />
              ))}
            </div>
            <span className="text-sm font-medium text-text-muted">Joined by thousands of groups</span>
          </motion.div>
        </motion.div>

        {/* Right — layered card cluster */}
        <HeroCluster float={float} reduce={reduce} />
        </div>
      </div>

      {/* Scroll cue — pinned to the bottom of the hero viewport */}
      {!reduce && (
        <motion.button
          onClick={() => scrollToId('social-band')}
          className="mx-auto flex shrink-0 flex-col items-center gap-1.5 pt-4 text-text-subtle"
          animate={{ y: [0, 6, 0] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
          aria-label="Scroll to explore"
        >
          <span className="text-[10px] font-semibold tracking-[0.2em]">SCROLL</span>
          <Icon name="chevron-left" size={22} className="-rotate-90" />
        </motion.button>
      )}
    </section>
  )
}

// A single floating panel with entrance + optional idle float.
function FloatCard({
  className,
  style,
  float,
  delay,
  rotate = 0,
  children,
}: {
  className?: string
  style?: React.CSSProperties
  float: object
  delay: number
  rotate?: number
  children: ReactNode
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 30, rotate }}
      whileInView={{ opacity: 1, y: 0, rotate }}
      viewport={viewport}
      transition={{ duration: 0.6, delay, ease: EASE }}
      className={cn('absolute', className)}
      style={{ rotate: `${rotate}deg`, ...style }}
    >
      <motion.div {...float}>{children}</motion.div>
    </motion.div>
  )
}

function HeroCluster({ float, reduce }: { float: (d: number, dist?: number) => object; reduce: boolean }) {
  return (
    <div className="relative mx-auto h-[440px] w-full max-w-[540px] sm:h-[520px]">
      {/* soft-orange glow behind the focal card */}
      <div className="absolute right-6 top-24 h-72 w-72 rounded-pill bg-primary-soft/40 blur-[90px]" />
      {/* recessed lightbox */}
      <div className="absolute inset-x-2 inset-y-6 rounded-[32px] bg-surface-panel" />

      {/* Group chat (back) */}
      <FloatCard
        float={reduce ? {} : float(0)}
        delay={0.1}
        rotate={-4}
        className="left-2 top-4 w-[62%] sm:left-4"
      >
        <div className="rounded-[20px] border border-surface-sunken bg-surface-raised p-4 shadow-[0_24px_60px_rgba(26,18,8,0.12)]">
          <div className="mb-3 flex items-center gap-2">
            <div className="flex -space-x-1.5">
              {['MA', 'PR', 'TO'].map((n, i) => (
                <MemberDot key={n} i={i} initials={n} size={24} ring="ring-surface-raised" />
              ))}
            </div>
            <span className="text-[13px] font-bold">Dinner crew · 4</span>
          </div>
          <div className="flex flex-col gap-2">
            <ChatBubble>somewhere vegan-friendly?</ChatBubble>
            <ChatBubble>under $25 each pls 🙏</ChatBubble>
            <ChatBubble me>I'm vegan though — walkable?</ChatBubble>
          </div>
          <div className="mt-3 flex items-center gap-2 rounded-pill bg-surface-sunken py-1.5 pl-3 pr-1.5">
            <span className="flex-1 text-[12px] text-text-muted">Message the group…</span>
            <span className="flex h-7 w-7 items-center justify-center rounded-pill bg-primary text-white">
              <Icon name="mic" size={13} />
            </span>
          </div>
        </div>
      </FloatCard>

      {/* AI agent bubble (top) */}
      <FloatCard
        float={reduce ? {} : float(1.2, 6)}
        delay={0.25}
        rotate={2}
        className="right-1 top-0 w-[58%]"
      >
        <div className="flex items-start gap-2.5 rounded-2xl border border-primary/25 bg-surface-raised p-3.5 shadow-[0_20px_50px_rgba(26,18,8,0.12)]">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <Icon name="sparkles" size={15} />
          </span>
          <p className="text-[12.5px] leading-snug">
            Reconciling 4 profiles… found 3 spots you'll all love.
          </p>
        </div>
      </FloatCard>

      {/* Restaurant match (focal, front) */}
      <FloatCard
        float={reduce ? {} : float(0.6, 12)}
        delay={0.4}
        rotate={4}
        className="bottom-2 right-0 w-[56%]"
      >
        <div className="overflow-hidden rounded-[18px] bg-surface-raised shadow-[0_36px_80px_rgba(26,18,8,0.18)]">
          <div className="relative h-28 bg-gradient-to-br from-member-terracotta to-primary">
            <span className="absolute left-3 top-3 rounded-pill bg-surface-raised px-2.5 py-1 text-[11px] font-bold text-primary">
              98% match
            </span>
          </div>
          <div className="p-4">
            <div className="flex items-center justify-between">
              <span className="text-[16px] font-bold">Verde Cocina</span>
              <span className="flex items-center gap-1 text-[13px] font-semibold">
                <Icon name="star" size={13} className="text-primary" filled />
                4.8
              </span>
            </div>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {['Vegan-friendly', '$$', '0.6 mi'].map((t) => (
                <span key={t} className="rounded-pill bg-surface-sunken px-2.5 py-1 text-[11px] font-medium">
                  {t}
                </span>
              ))}
            </div>
          </div>
        </div>
      </FloatCard>

      {/* Shared cart chip (bottom-left) */}
      <FloatCard
        float={reduce ? {} : float(1.8, 8)}
        delay={0.5}
        rotate={-3}
        className="bottom-6 left-0 w-[46%]"
      >
        <div className="rounded-2xl bg-surface-raised p-3.5 shadow-[0_24px_56px_rgba(26,18,8,0.14)]">
          <div className="flex items-center gap-2">
            <Icon name="wallet" size={15} />
            <span className="text-[12.5px] font-bold">Group cart · 4</span>
          </div>
          <div className="mt-2.5 flex items-center justify-between">
            <div className="flex -space-x-1.5">
              {['MA', 'PR', 'TO', 'DE'].map((n, i) => (
                <MemberDot key={n} i={i} initials={n} size={22} ring="ring-surface-raised" />
              ))}
            </div>
            <span className="text-[14px] font-bold">$86</span>
          </div>
        </div>
      </FloatCard>
    </div>
  )
}

function ChatBubble({ children, me = false }: { children: ReactNode; me?: boolean }) {
  return (
    <div className={cn('flex', me && 'justify-end')}>
      <span
        className={cn(
          'max-w-[85%] rounded-2xl px-3 py-2 text-[12.5px] leading-snug',
          me ? 'bg-surface-inverse text-white' : 'bg-surface-sunken text-text',
        )}
      >
        {children}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// §3 Social proof band
function SocialBand() {
  const fadeUp = useFadeUp()
  const stats = [
    ['12k+', 'sessions'],
    ['4.9', 'avg group rating'],
    ['30 sec', 'to consensus'],
  ]
  return (
    <section id="social-band" className="border-y border-border bg-surface-sunken/60">
      <motion.div
        initial="hidden"
        whileInView="show"
        viewport={viewport}
        variants={fadeUp}
        className="mx-auto flex max-w-[1200px] flex-col items-center justify-between gap-6 px-6 py-8 lg:flex-row lg:px-8"
      >
        <div className="flex items-center gap-4">
          <div className="flex -space-x-2.5">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <MemberDot key={i} i={i} initials={['MA', 'PR', 'SO', 'TO', 'DE', 'CA'][i]} size={34} />
            ))}
          </div>
          <span className="text-[15px] font-bold">Joined by thousands of groups</span>
        </div>
        <div className="flex items-center gap-6">
          {stats.map(([n, l], i) => (
            <div key={l} className="flex items-center gap-2">
              {i > 0 && <span className="mr-4 hidden h-5 w-px bg-border sm:block" />}
              <span className="text-[15px] font-extrabold text-primary">{n}</span>
              <span className="text-[13px] font-medium text-text-muted">{l}</span>
            </div>
          ))}
        </div>
      </motion.div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// §4 How it works — the 3 "steps to one table" cards (hover-lift)
const STEPS: { n: string; icon: IconName; eyebrow: string; title: string; body: string }[] = [
  {
    n: '01',
    icon: 'message',
    eyebrow: 'DISCOVER',
    title: 'Chat with your group',
    body: 'Start a session from any group chat. Everyone gets their own private AI food agent.',
  },
  {
    n: '02',
    icon: 'mic',
    eyebrow: 'PLAN',
    title: 'Tell it what you want',
    body: 'Talk or type — mood, budget, dietary needs, location. Your agent already knows your profile.',
  },
  {
    n: '03',
    icon: 'sparkles',
    eyebrow: 'COORDINATE',
    title: 'One perfect pick',
    body: 'The orchestrator finds spots that work for everyone. Vote on the top picks, confirm in seconds.',
  },
]

// Public switch: on desktop with motion allowed, the steps play as a
// scroll-pinned reveal (numbers 1→2→3 + their cards appear in sequence). On
// mobile or with reduced motion, fall back to the static grid — which is also
// the no-JS baseline (all three steps in the DOM). The `useMediaQuery` default
// (false) means the static grid renders on first paint, then upgrades once JS
// confirms the ≥640px match, so there's no layout pop.
function HowItWorks() {
  const reduce = useReducedMotion()
  const isDesktop = useMediaQuery('(min-width: 640px)')
  if (reduce || !isDesktop) return <HowItWorksStatic />
  return <HowItWorksPinned />
}

function HowItWorksStatic() {
  const reduce = useReducedMotion()
  const fadeUp = useFadeUp()
  return (
    <section id="how-it-works" className="scroll-mt-[72px] bg-surface-raised px-6 py-20 lg:px-8 lg:py-24">
      <SectionHeader eyebrow="HOW IT WORKS" title="Three steps to one table." />
      <div className="mx-auto mt-14 grid max-w-[1100px] gap-6 sm:grid-cols-3">
        {STEPS.map((s, i) => (
          <motion.article
            key={s.n}
            custom={i}
            initial="hidden"
            whileInView="show"
            viewport={viewport}
            variants={fadeUp}
            whileHover={reduce ? undefined : { y: -8, boxShadow: '0 24px 48px rgba(26,18,8,0.12)' }}
            transition={{ type: 'spring', stiffness: 300, damping: 24 }}
            className={cn(
              'group relative rounded-card bg-surface p-8 shadow-sm',
              // editorial stagger: middle card sits lower on desktop
              i === 1 && 'sm:mt-8',
            )}
          >
            {/* ghost numeral peeking above the card */}
            <span className="pointer-events-none absolute -top-14 left-4 font-display text-[120px] font-extrabold leading-none text-text/[0.05]">
              {s.n}
            </span>
            <span className="relative flex h-13 w-13 items-center justify-center rounded-2xl bg-primary-soft/25 text-primary">
              <Icon name={s.icon} size={24} />
            </span>
            <p className="mt-4 text-[11px] font-semibold tracking-[0.1em] text-text-muted">{s.eyebrow}</p>
            <h3 className="mt-1.5 font-display text-[22px] font-bold">{s.title}</h3>
            <p className="mt-3 text-[15px] leading-relaxed text-text-muted">{s.body}</p>
          </motion.article>
        ))}
      </div>
    </section>
  )
}

// Scroll-pinned variant of §4. A tall track holds an inner sticky stage under
// the nav; as the user scrolls, `scrollYProgress` (0→1) drives the three steps
// one at a time — each step's big numeral pops first, then its card slides up a
// beat later. Step 3 persists to the end of the pin. When the pin releases, the
// full §4 three-card grid (01/02/03 numerals) sits directly below in normal
// flow and stays on screen — the sequence hands off to it rather than vanishing.
// Desktop + motion-allowed only (gated by the HowItWorks switch).

// Active window start per step (0-based). Step 3 has no successor, so it holds.
const PIN_STARTS = [0, 0.33, 0.66] as const

// Motion values for one step (numeral leads, card follows ~0.05 later). `last`
// keeps step 3 visible through progress = 1 instead of fading it back out.
function useStepMotion(scrollYProgress: MotionValue<number>, start: number, last: boolean) {
  const endOpacity = last ? 1 : 0
  const numOpacity = useTransform(
    scrollYProgress,
    [start, start + 0.06, start + 0.27, start + 0.33],
    [0, 1, 1, endOpacity],
  )
  const numY = useTransform(scrollYProgress, [start, start + 0.06], [40, 0])
  const cardOpacity = useTransform(
    scrollYProgress,
    [start + 0.05, start + 0.12, start + 0.27, start + 0.33],
    [0, 1, 1, endOpacity],
  )
  const cardY = useTransform(scrollYProgress, [start + 0.05, start + 0.12], [48, 0])
  const cardScale = useTransform(scrollYProgress, [start + 0.05, start + 0.12], [0.94, 1])
  return { numOpacity, numY, cardOpacity, cardY, cardScale }
}

function HowItWorksPinned() {
  const trackRef = useRef<HTMLDivElement>(null)
  const { scrollYProgress } = useScroll({
    target: trackRef,
    offset: ['start start', 'end end'],
  })

  // One motion set per step — declared at the top level (never inside .map),
  // so the hook count stays constant.
  const s1 = useStepMotion(scrollYProgress, PIN_STARTS[0], false)
  const s2 = useStepMotion(scrollYProgress, PIN_STARTS[1], false)
  const s3 = useStepMotion(scrollYProgress, PIN_STARTS[2], true)
  const motions = [s1, s2, s3]

  // After step 3, fade the whole solo stage (numeral + card deck + glow) out so
  // no empty ghost cards linger at the tail — hands off to the finale grid.
  const stageOpacity = useTransform(scrollYProgress, [0.9, 1], [1, 0])

  // Entrance for the persistent finale grid.
  const fadeUp = useFadeUp()

  return (
    <section id="how-it-works" className="scroll-mt-[72px] bg-surface-raised">
      {/* Pinned sequence — plays 1 → 2 → 3 while the stage stays fixed */}
      <div ref={trackRef} className="relative h-[240vh]">
        <div className="sticky top-[72px] flex min-h-[calc(100vh-72px)] flex-col justify-center overflow-hidden px-6 py-12 lg:px-8">
          <motion.div style={{ opacity: stageOpacity }} className="mx-auto w-full max-w-[1100px]">
            <SectionHeader eyebrow="HOW IT WORKS" title="Three steps to one table." />

            <div className="relative mt-10 grid items-center gap-10 lg:mt-14 lg:grid-cols-[0.8fr_1fr]">
              {/* Left — cross-fading big numeral + eyebrow, centered in its column */}
              <div className="relative flex h-[200px] items-center justify-center lg:h-[300px]">
                {/* soft glow, hero language */}
                <div className="pointer-events-none absolute left-1/2 top-1/2 h-64 w-64 -translate-x-1/2 -translate-y-1/2 rounded-pill bg-primary-soft/40 blur-[90px]" />
                {STEPS.map((s, i) => (
                  <motion.div
                    key={s.n}
                    style={{ opacity: motions[i].numOpacity, y: motions[i].numY }}
                    className="absolute inset-0 flex flex-col items-center justify-center"
                  >
                    <span className="text-[12px] font-semibold tracking-[0.15em] text-primary">
                      {s.eyebrow}
                    </span>
                    <span className="font-display text-[160px] font-extrabold leading-none text-primary lg:text-[240px]">
                      {String(i + 1)}
                    </span>
                  </motion.div>
                ))}
              </div>

              {/* Right — cross-fading modal cards, layered like a deck */}
              <div className="relative h-[300px] lg:h-[340px]">
                {/* faint ghost cards behind, so the stack reads as a deck */}
                <div className="pointer-events-none absolute inset-x-4 top-6 h-full rotate-3 rounded-[20px] bg-surface-panel/70" />
                <div className="pointer-events-none absolute inset-x-6 top-10 h-full -rotate-3 rounded-[20px] bg-surface-panel/50" />
                {STEPS.map((s, i) => (
                  <motion.div
                    key={s.n}
                    style={{
                      opacity: motions[i].cardOpacity,
                      y: motions[i].cardY,
                      scale: motions[i].cardScale,
                    }}
                    className="absolute inset-0 flex flex-col justify-center rounded-[20px] border border-surface-sunken bg-surface-raised p-7 shadow-[0_36px_80px_rgba(26,18,8,0.18)] lg:p-8"
                  >
                    <span className="flex h-13 w-13 items-center justify-center rounded-2xl bg-primary-soft/25 text-primary">
                      <Icon name={s.icon} size={24} />
                    </span>
                    <p className="mt-4 text-[11px] font-semibold tracking-[0.1em] text-text-muted">
                      {s.eyebrow}
                    </p>
                    <h3 className="mt-1.5 font-display text-[22px] font-bold">{s.title}</h3>
                    <p className="mt-3 text-[15px] leading-relaxed text-text-muted">{s.body}</p>
                  </motion.div>
                ))}
              </div>
            </div>
          </motion.div>
        </div>
      </div>

      {/* Persistent finale — the §4 three-card grid stays on screen after the
          pin releases (scrolls normally into the rest of the page). */}
      <div className="px-6 pb-20 lg:px-8 lg:pb-24">
        <motion.div
          initial="hidden"
          whileInView="show"
          viewport={viewport}
          variants={fadeUp}
          className="mx-auto grid max-w-[1100px] gap-6 sm:grid-cols-3"
        >
          {STEPS.map((s, i) => (
            <div
              key={s.n}
              className={cn(
                'relative rounded-card bg-surface p-8 shadow-sm',
                i === 1 && 'sm:mt-8',
              )}
            >
              {/* ghost numeral peeking above the card */}
              <span className="pointer-events-none absolute -top-14 left-4 font-display text-[120px] font-extrabold leading-none text-text/[0.05]">
                {s.n}
              </span>
              <span className="relative flex h-13 w-13 items-center justify-center rounded-2xl bg-primary-soft/25 text-primary">
                <Icon name={s.icon} size={24} />
              </span>
              <p className="mt-4 text-[11px] font-semibold tracking-[0.1em] text-text-muted">
                {s.eyebrow}
              </p>
              <h3 className="mt-1.5 font-display text-[22px] font-bold">{s.title}</h3>
              <p className="mt-3 text-[15px] leading-relaxed text-text-muted">{s.body}</p>
            </div>
          ))}
        </motion.div>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// §5 Feature showcase — inset dark consensus panel + supporting cards + strip
function FeatureShowcase() {
  const fadeUp = useFadeUp()
  const prefs = [
    { i: 0, label: 'Vegan' },
    { i: 1, label: '≤ $25' },
    { i: 3, label: 'Walkable' },
    { i: 4, label: 'Spicy ok' },
  ]
  const votes = [
    ['Verde Cocina', 62, true],
    ['Casa Verde', 28, false],
    ["Nonna's Table", 10, false],
  ] as const
  return (
    <section id="features" className="scroll-mt-[72px] bg-surface-sunken px-6 py-20 lg:px-8 lg:py-24">
      <div className="mx-auto max-w-[1200px]">
        <SectionHeader eyebrow="WHY GRUBGROUP" title="Private agents. One shared decision." align="left" />
        <div className="mt-12 grid gap-6 lg:grid-cols-[1.4fr_1fr]">
          {/* Large inset dark panel */}
          <motion.div
            initial="hidden"
            whileInView="show"
            viewport={viewport}
            variants={fadeUp}
            className="relative overflow-hidden rounded-[20px] bg-surface-inverse p-8 text-white shadow-lg"
          >
            <div className="absolute right-8 top-16 h-56 w-56 rounded-pill bg-primary/25 blur-[100px]" />
            <h3 className="relative font-display text-[24px] font-bold leading-tight">
              Per-person private AI →<br />one group consensus
            </h3>
            <div className="relative mt-6 flex flex-col gap-2.5 sm:flex-row sm:items-center sm:gap-6">
              <div className="flex flex-col gap-2.5">
                {prefs.map((p) => (
                  <span
                    key={p.label}
                    className="flex w-fit items-center gap-2 rounded-pill bg-white/10 py-1.5 pl-1.5 pr-3.5"
                  >
                    <MemberDot i={p.i} size={22} ring="ring-transparent" />
                    <span className="text-[13px] font-medium">{p.label}</span>
                  </span>
                ))}
              </div>
              <Icon name="arrow-right" size={26} className="hidden text-primary sm:block" />
              <div className="overflow-hidden rounded-2xl bg-surface-raised text-text shadow-xl sm:ml-2 sm:w-64">
                <div className="h-20 bg-gradient-to-br from-member-terracotta to-primary" />
                <div className="p-3.5">
                  <span className="rounded-pill bg-primary/10 px-2 py-0.5 text-[11px] font-bold text-primary">
                    96% match
                  </span>
                  <p className="mt-2 text-[15px] font-bold">Casa Verde</p>
                  <p className="text-[12px] text-text-muted">Mexican · $$ · works for all 4</p>
                </div>
              </div>
            </div>
            <p className="relative mt-6 max-w-md text-[14px] leading-relaxed text-white/60">
              Everyone's needs, reconciled automatically — vegan, halal, budget, a two-mile radius.
            </p>
          </motion.div>

          {/* Supporting cards */}
          <div className="grid gap-6">
            <FeatureCard i={0} icon="wallet" title="Shared group cart" body="Everyone's picks merge into one order — split fairly, checkout once.">
              <div className="mt-4 flex -space-x-2">
                {['MA', 'PR', 'TO', 'DE'].map((n, i) => (
                  <MemberDot key={n} i={i} initials={n} size={26} ring="ring-surface-raised" />
                ))}
              </div>
            </FeatureCard>
            <FeatureCard i={1} icon="party" title="Vote to decide" body="Top three picks, one tap each — the group settles it fast.">
              <div className="mt-4 flex flex-col gap-2">
                {votes.map(([name, pct, lead]) => (
                  <div key={name}>
                    <div className="flex justify-between text-[12px]">
                      <span className="font-semibold">{name}</span>
                      <span className={cn('font-bold', lead ? 'text-primary' : 'text-text-muted')}>{pct}%</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-pill bg-surface-sunken">
                      <div className="h-full rounded-pill bg-primary" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </FeatureCard>
          </div>
        </div>

        {/* Full-width strip */}
        <motion.div
          initial="hidden"
          whileInView="show"
          viewport={viewport}
          variants={fadeUp}
          className="mt-6 flex flex-col items-start gap-5 rounded-card bg-surface-panel p-6 shadow-inner sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex items-center gap-4">
            <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-surface-inverse text-white">
              <Icon name="user" size={22} />
            </span>
            <div>
              <p className="font-display text-[20px] font-bold">Set preferences once. Never repeat yourself.</p>
              <p className="text-[14px] text-text-muted">Your agent remembers every time.</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {['Vegan', 'No shellfish', '$$', '≤ 2 mi'].map((c) => (
              <span key={c} className="rounded-pill bg-surface-inverse px-3 py-2 text-[13px] font-medium text-white">
                {c}
              </span>
            ))}
          </div>
        </motion.div>
      </div>
    </section>
  )
}

function FeatureCard({
  i,
  icon,
  title,
  body,
  children,
}: {
  i: number
  icon: IconName
  title: string
  body: string
  children?: ReactNode
}) {
  const reduce = useReducedMotion()
  const fadeUp = useFadeUp()
  return (
    <motion.div
      custom={i}
      initial="hidden"
      whileInView="show"
      viewport={viewport}
      variants={fadeUp}
      whileHover={reduce ? undefined : { y: -6, boxShadow: '0 20px 40px rgba(26,18,8,0.12)' }}
      transition={{ type: 'spring', stiffness: 300, damping: 24 }}
      className="rounded-card bg-surface-raised p-6 shadow-sm"
    >
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary-soft/25 text-primary">
        <Icon name={icon} size={22} />
      </span>
      <h3 className="mt-4 font-display text-[19px] font-bold">{title}</h3>
      <p className="mt-1.5 text-[14px] leading-relaxed text-text-muted">{body}</p>
      {children}
    </motion.div>
  )
}

// ---------------------------------------------------------------------------
// §6 Product in use — the one dark tentpole
function ProductInUse() {
  const fadeUp = useFadeUp()
  const cards = ['Verde Cocina', 'Casa Verde', "Nonna's", 'Sakura', 'Olive & Ash', 'Fuego']
  const pcts = ['98%', '94%', '91%', '88%', '85%', '82%']
  return (
    <section id="discover" className="scroll-mt-[72px] relative overflow-hidden bg-surface-inverse px-6 py-20 text-white lg:px-8 lg:py-24">
      <div className="absolute left-1/2 top-40 h-96 w-[42rem] -translate-x-1/2 rounded-pill bg-primary/15 blur-[160px]" />
      <div className="relative mx-auto max-w-[1100px]">
        <SectionHeader eyebrow="SEE IT IN MOTION" title="Watch a group land on dinner." dark />
        <motion.div
          initial="hidden"
          whileInView="show"
          viewport={viewport}
          variants={fadeUp}
          className="mx-auto mt-12 max-w-3xl overflow-hidden rounded-2xl bg-surface-raised shadow-2xl"
        >
          <div className="flex items-center gap-1.5 border-b border-border bg-surface-sunken px-4 py-3">
            {['bg-member-pink', 'bg-primary', 'bg-member-green'].map((c) => (
              <span key={c} className={cn('h-2.5 w-2.5 rounded-pill opacity-60', c)} />
            ))}
            <span className="ml-3 text-[13px] font-semibold text-text">Discover · 12 spots your group will love</span>
          </div>
          <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3">
            {cards.map((name, i) => (
              <div key={name} className="overflow-hidden rounded-xl bg-surface">
                <div className={cn('relative h-20', ['bg-member-terracotta', 'bg-primary', 'bg-member-amber', 'bg-member-pink', 'bg-member-green', 'bg-member-blue'][i])}>
                  <span className="absolute left-2 top-2 rounded-pill bg-surface-raised px-1.5 py-0.5 text-[10px] font-bold text-primary">
                    {pcts[i]}
                  </span>
                </div>
                <div className="p-2.5 text-text">
                  <p className="text-[12px] font-bold">{name}</p>
                  <p className="flex items-center gap-1 text-[11px] text-text-muted">
                    <Icon name="star" size={10} className="text-primary" filled /> 4.8 · $$
                  </p>
                </div>
              </div>
            ))}
          </div>
        </motion.div>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// §7 Emotional benefit
function EmotionalBenefit() {
  const fadeUp = useFadeUp()
  return (
    <section className="bg-surface-panel px-6 py-20 lg:px-8 lg:py-24">
      <div className="mx-auto grid max-w-[1100px] items-center gap-12 lg:grid-cols-2">
        <motion.div initial="hidden" whileInView="show" viewport={viewport} variants={fadeUp}>
          <h2 className="font-display text-[40px] font-extrabold leading-[1.05] sm:text-[52px]">
            Less deciding.
            <br />
            More dining.
          </h2>
          <p className="mt-5 max-w-md text-[17px] leading-relaxed text-text-muted">
            No more forty-message threads or the friend who “doesn't care, anything's fine.” GrubGroup
            turns indecision into a table, booked.
          </p>
          <button
            onClick={() => scrollToId('how-it-works')}
            className="mt-6 inline-flex items-center gap-2 text-[16px] font-semibold text-text transition-colors hover:text-primary"
          >
            See how it works <Icon name="arrow-right" size={18} />
          </button>
        </motion.div>
        <motion.div
          initial="hidden"
          whileInView="show"
          viewport={viewport}
          variants={fadeUp}
          className="relative flex h-72 items-center justify-center rounded-[20px] bg-gradient-to-br from-primary to-member-terracotta shadow-lg"
        >
          <div className="flex -space-x-3">
            {[0, 1, 3, 4, 5].map((i) => (
              <MemberDot key={i} i={i} initials={['MA', 'PR', 'TO', 'DE', 'CA'][[0, 1, 3, 4, 5].indexOf(i)]} size={56} ring="ring-white" />
            ))}
          </div>
          <div className="absolute -bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-2xl bg-surface-raised px-4 py-3 shadow-lg">
            <span className="flex h-7 w-7 items-center justify-center rounded-pill bg-success/15 text-success">
              <Icon name="check" size={16} />
            </span>
            <span className="text-[15px] font-bold">Planned in 30 seconds</span>
          </div>
        </motion.div>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// §8 Final CTA — cocoa card on sand
function FinalCta({ toSignUp }: { toSignUp: () => void }) {
  const fadeUp = useFadeUp()
  return (
    <section className="bg-surface px-6 py-16 lg:px-8 lg:py-24">
      <motion.div
        initial="hidden"
        whileInView="show"
        viewport={viewport}
        variants={fadeUp}
        className="relative mx-auto flex max-w-[1000px] flex-col items-center overflow-hidden rounded-[28px] bg-surface-inverse px-8 py-16 text-center text-white shadow-xl"
      >
        <div className="absolute left-1/2 top-8 h-64 w-96 -translate-x-1/2 rounded-pill bg-primary/22 blur-[120px]" />
        <h2 className="relative font-display text-[36px] font-extrabold leading-tight sm:text-[42px]">
          The restaurant <span className="text-primary">everyone</span> agrees on.
        </h2>
        <p className="relative mt-4 max-w-lg text-[17px] text-white/60">
          Start a session, invite your group, and let the agents do the rest.
        </p>
        <Button
          variant="accent"
          size="lg"
          onClick={toSignUp}
          leftIcon={<MicPop size={18} hoverClass="group-hover:text-surface-inverse" />}
          className="group relative mt-8 rounded-pill"
        >
          Start a session
        </Button>
        <p className="relative mt-4 text-[13px] font-medium text-white/40">
          Free to start · Guest mode, no account needed.
        </p>
      </motion.div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// §9 Footer
function Footer() {
  const cols: { title: string; links: string[] }[] = [
    { title: 'Product', links: ['How it works', 'Features', 'Discover', 'Pricing'] },
    { title: 'Company', links: ['About', 'Careers', 'Blog'] },
    { title: 'Support', links: ['Help', 'Contact', 'Status'] },
    { title: 'Legal', links: ['Privacy', 'Terms'] },
  ]
  return (
    <footer className="bg-surface-inverse px-6 pb-10 pt-16 text-white lg:px-8">
      <div className="mx-auto max-w-[1200px]">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-[1.5fr_repeat(4,1fr)]">
          <div>
            <Wordmark dark />
            <p className="mt-4 max-w-xs text-[15px] text-white/60">The restaurant everyone agrees on.</p>
            <p className="mt-3 text-[14px] text-white/40">hello@grubgroup.app</p>
          </div>
          {cols.map((c) => (
            <div key={c.title}>
              <p className="text-[14px] font-bold">{c.title}</p>
              <ul className="mt-3 flex flex-col gap-3">
                {c.links.map((l) => (
                  <li key={l}>
                    <button className="text-[14px] text-white/50 transition-colors hover:text-white">{l}</button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="mt-12 flex flex-col items-center justify-between gap-4 border-t border-white/[0.06] pt-6 sm:flex-row">
          <span className="text-[13px] text-white/40">© 2026 GrubGroup</span>
          <div className="flex gap-2">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <span key={i} className={cn('h-2.5 w-2.5 rounded-pill', MEMBER_BG[i])} />
            ))}
          </div>
        </div>
      </div>
    </footer>
  )
}

// ---------------------------------------------------------------------------
function SectionHeader({
  eyebrow,
  title,
  align = 'center',
  dark = false,
}: {
  eyebrow: string
  title: string
  align?: 'center' | 'left'
  dark?: boolean
}) {
  const fadeUp = useFadeUp()
  return (
    <motion.div
      initial="hidden"
      whileInView="show"
      viewport={viewport}
      variants={fadeUp}
      className={cn('flex flex-col gap-3', align === 'center' ? 'items-center text-center' : 'items-start text-left')}
    >
      <span className="text-[12px] font-semibold tracking-[0.15em] text-primary">{eyebrow}</span>
      <h2 className={cn('font-display text-[32px] font-extrabold sm:text-[38px]', dark ? 'text-white' : 'text-text')}>
        {title}
      </h2>
    </motion.div>
  )
}
