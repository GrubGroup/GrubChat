import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { motion, useReducedMotion, type Variants } from 'framer-motion'
import { Avatar, Badge, Button, Icon, Modal } from '@/components/ui'
import { BottomTabBar, TabBarSpacer } from '@/components/layout/BottomTabBar'
import { EASE } from '@/lib/motion'
import { PreferenceTag } from '@/components/profile/PreferenceTag'
import { CUISINES, DIETARY_RESTRICTIONS, isAllergen, labelFor } from '@/constants/dietary'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useSignOut } from '@/hooks/useSignOut'
import { useAuthStore } from '@/stores/authStore'
import { memberColor } from '@/constants/memberColors'
import { useProfileStore } from '@/stores/profileStore'
import { useRestaurantStore } from '@/stores/restaurantStore'

// Web-only staggered reveal for the profile blocks: as the page pushes in from
// the rail, each block cascades in after the last. Applied only when `animate` is
// on (desktop, motion allowed); on mobile / reduced-motion the blocks render
// statically. Mirrors the section stagger used on the settings page.
//
// `hidden` doubles as the EXIT: clicking Back animates the container back to
// `hidden`, so the same blocks cascade out — in reverse order (`staggerDirection`
// -1) so it reads as the entrance played backwards. `when: 'afterChildren'` makes
// the container's onAnimationComplete wait for every block, which is what triggers
// the actual navigation (see the container below).
const blocksContainer = {
  hidden: { transition: { staggerChildren: 0.05, staggerDirection: -1, when: 'afterChildren' } },
  show: { transition: { staggerChildren: 0.06, delayChildren: 0.08 } },
}
const blockItem: Variants = {
  hidden: { opacity: 0, y: 12, transition: { duration: 0.25, ease: EASE } },
  show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: EASE } },
}

// Read-only profile view. Composes the domain User (header identity) with the
// Profile (dining preferences). Mirrors the "[Orange] Profile" wireframe.
export function ProfilePage() {
  const reduce = useReducedMotion()
  // Below `md` the profile is a bottom-tab ROOT, and the other two roots (Groups,
  // Events) paint instantly — an entrance fade/rise only here makes tapping the
  // Profile tab feel slower than its neighbours. Keep it at ≥md, where the page is
  // PUSHED from the rail's account menu and the motion reads as the push.
  const isMobile = useIsMobile()
  const animate = !isMobile && !reduce
  const navigate = useNavigate()
  const location = useLocation()
  const user = useAuthStore((s) => s.user)
  const profile = useProfileStore((s) => s.profile)
  const load = useProfileStore((s) => s.load)
  const restaurantsById = useRestaurantStore((s) => s.byId)
  const restaurantsLoaded = useRestaurantStore((s) => s.loaded)
  const loadRestaurants = useRestaurantStore((s) => s.load)
  // Same flow the sidebar rail's AccountMenu uses, so the two can't drift.
  const handleSignOut = useSignOut()
  // Sign-out is destructive-ish (drops local state, ends the session), so it's
  // gated behind a confirm modal, mirroring the "Leave group?" flow.
  const [confirmingSignOut, setConfirmingSignOut] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  // Web-only exit: clicking Back fades/drops the page out (mirroring the entrance)
  // before we actually navigate, so the push in and the pop out feel symmetric.
  const [leaving, setLeaving] = useState(false)

  const confirmSignOut = async () => {
    setSigningOut(true)
    try {
      await handleSignOut()
    } finally {
      // On success we've navigated away; on failure re-enable so it's retryable.
      setSigningOut(false)
    }
  }

  useEffect(() => {
    if (!profile) void load()
    if (!restaurantsLoaded) void loadRestaurants()
  }, [profile, load, restaurantsLoaded, loadRestaurants])

  const dietary = profile?.dietary_restrictions ?? []
  const allergyValues = dietary.filter(isAllergen)
  const dietValues = dietary.filter((v) => !isAllergen(v))
  const preferred = profile?.preferred_cuisines ?? []
  const disliked = profile?.disliked_cuisines ?? []
  const liked = (profile?.liked_restaurant_ids ?? [])
    .map((id) => restaurantsById[id])
    .filter(Boolean)

  const displayName = user?.display_name ?? user?.username ?? 'You'

  // Back returns wherever the user came from — the account menu opens the profile
  // from many screens, so there's no single origin. A 'default' location key means
  // this was the entry point (a deep link or a fresh reload) and there's nothing to
  // go back to, so fall through to the app's home instead of leaving the site.
  const doNavigateBack = () =>
    location.key === 'default' ? navigate('/groups') : navigate(-1)

  // On desktop, run the exit animation first and navigate when it finishes (see
  // onAnimationComplete below). On mobile / reduced-motion there's no entrance, so
  // Back should navigate instantly — animating the exit alone would feel lopsided.
  const goBack = () => {
    if (animate) setLeaving(true)
    else doNavigateBack()
  }

  return (
    <motion.div
      className="h-dvh overflow-y-auto bg-surface-raised"
      // Root stays fully opaque throughout — its `bg-surface-raised` is the page
      // backdrop. Fading it out on exit revealed the (dark) app backdrop behind,
      // since the previous route isn't mounted yet. Only the content cascades out.
      initial={animate ? { opacity: 0, y: 8 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={animate ? { duration: 0.3, ease: EASE } : { duration: 0 }}
    >
      <div className="mx-auto max-w-3xl">
        {/* Header bar */}
        <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-6 sm:px-8">
          <div className="min-w-0">
            {/* Back — DESKTOP ONLY. At ≥md the profile is pushed from the rail's
                account menu, so it has an origin to return to (returnTo). Below
                `md` it's a tab ROOT reached from the bottom bar: there is nothing
                to go back to, and the chevron would strand the user on whichever
                screen returnTo happened to be stamped with. */}
            <button
              onClick={goBack}
              className="tap-target mb-2 hidden items-center gap-1 text-body text-text-muted hover:text-text md:flex"
            >
              <Icon name="chevron-left" size={14} /> Back
            </button>
            <h1 className="font-display text-display font-bold text-text">Your profile</h1>
            <p className="text-body text-text-muted">
              Set once — your agent remembers this for every session
            </p>
          </div>
          <Button
            variant="primary"
            className="shrink-0"
            leftIcon={<Icon name="pencil" size={14} />}
            onClick={() => navigate('/profile/edit')}
          >
            {/* "Edit profile" is too wide to sit beside the title at 390px; the
                pencil already carries the meaning, so drop the noun below `sm`
                rather than stacking the button under a wrapped subtitle. */}
            <span className="sm:hidden">Edit</span>
            <span className="hidden sm:inline">Edit profile</span>
          </Button>
        </div>

        <motion.div
          className="flex flex-col gap-8 px-4 py-6 sm:px-8"
          variants={animate ? blocksContainer : undefined}
          initial={animate ? 'hidden' : false}
          animate={animate ? (leaving ? 'hidden' : 'show') : false}
          onAnimationComplete={(def) => {
            // Fires for both directions; only the exit cascade ('hidden' while
            // leaving) should navigate.
            if (leaving && def === 'hidden') doNavigateBack()
          }}
        >
          {/* Identity row — stacks below `sm`: the avatar + name + email and the
              "Preferences saved" confirmation can't share one 390px row. */}
          <motion.div
            variants={animate ? blockItem : undefined}
            className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
          >
            <div className="flex min-w-0 items-center gap-4">
              <Avatar
                name={displayName}
                src={user?.avatar_url}
                size="lg"
                colorClass={memberColor(user?.id ?? -1)}
              />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-display text-panel-title font-bold text-text">{displayName}</h2>
                  <Badge tone="neutral">Member</Badge>
                </div>
                {/* Handle and email are separate lines, not "@you · a@b.com" on
                    one truncated row: at 390px the avatar + gap leave ~250px, so
                    a real address was always clipped mid-domain (or cut entirely
                    when the handle was long). The email wraps on `break-words`
                    instead of truncating — an address you can't read in full is
                    useless here, and it's the field users check. */}
                <p className="truncate text-body text-text-muted">
                  @{user?.username ?? 'you'}
                </p>
                {user?.email && (
                  <p className="break-words text-body text-text-muted">{user.email}</p>
                )}
              </div>
            </div>
            <span className="flex shrink-0 items-center gap-1.5 text-body font-medium text-text-muted">
              <Icon name="check" size={14} /> Preferences saved
            </span>
          </motion.div>

          {/* Account settings — MOBILE ONLY. At ≥md this is reached from the
              sidebar rail's AccountMenu, but that rail is hidden below `md`, so
              this is the only route to /settings at phone width. Ghost + border
              reads as a quiet navigation control, not a primary CTA. */}
          <div className="md:hidden">
            <Button
              variant="ghost"
              fullWidth
              className="border border-border"
              leftIcon={<Icon name="settings" size={16} />}
              onClick={() => navigate('/settings')}
            >
              Account settings
            </Button>
          </div>

          {/* Dietary needs */}
          <Section label="Dietary needs" variants={animate ? blockItem : undefined}>
            {allergyValues.length + dietValues.length === 0 ? (
              <Empty>No dietary needs set.</Empty>
            ) : (
              <div className="flex flex-wrap gap-2">
                {allergyValues.map((v) => (
                  <PreferenceTag key={v} tone="allergy">
                    {labelFor(DIETARY_RESTRICTIONS, v)}
                  </PreferenceTag>
                ))}
                {dietValues.map((v) => (
                  <PreferenceTag key={v} tone="diet">
                    {labelFor(DIETARY_RESTRICTIONS, v)}
                  </PreferenceTag>
                ))}
              </div>
            )}
          </Section>

          {/* Budget + location card */}
          <motion.div
            variants={animate ? blockItem : undefined}
            className="overflow-hidden rounded-card border border-border"
          >
            <InfoRow
              icon="wallet"
              title="Typical budget"
              value={`$${profile?.budget_min ?? 0}–${profile?.budget_max ?? 0} per person`}
            />
            <div className="h-px bg-border" />
            <InfoRow
              icon="map-pin"
              title="Default location"
              value={
                profile?.default_address
                  ? profile.default_radius
                    ? `${profile.default_address} · within ${profile.default_radius} mi`
                    : profile.default_address
                  : 'Not set'
              }
            />
          </motion.div>

          {/* Preferred cuisines */}
          <Section label="Preferred cuisines" variants={animate ? blockItem : undefined}>
            {preferred.length === 0 ? (
              <Empty>No preferred cuisines yet.</Empty>
            ) : (
              <div className="flex flex-wrap gap-2">
                {preferred.map((v) => (
                  <PreferenceTag key={v} tone="preferred">
                    {labelFor(CUISINES, v)}
                  </PreferenceTag>
                ))}
              </div>
            )}
          </Section>

          {/* Disliked cuisines */}
          <Section label="Disliked cuisines" variants={animate ? blockItem : undefined}>
            {disliked.length === 0 ? (
              <Empty>Nothing to avoid.</Empty>
            ) : (
              <div className="flex flex-wrap gap-2">
                {disliked.map((v) => (
                  <PreferenceTag key={v} tone="disliked">
                    {labelFor(CUISINES, v)}
                  </PreferenceTag>
                ))}
              </div>
            )}
          </Section>

          {/* Liked restaurants */}
          <Section label="Liked restaurants" variants={animate ? blockItem : undefined}>
            {liked.length === 0 ? (
              <Empty>No favorites yet.</Empty>
            ) : (
              <div className="overflow-hidden rounded-card border border-border">
                {liked.map((r, i) => (
                  <div key={r.id}>
                    {i > 0 && <div className="h-px bg-border" />}
                    <div className="flex items-center gap-3 px-4 py-3.5">
                      <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-surface-sunken text-lg">
                        {r.cuisine_tags?.[0] ? '🍽️' : '🍽️'}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-body font-semibold text-text">{r.name}</p>
                        <p className="truncate text-caption text-text-muted">
                          {r.cuisine_tags?.[0] ?? 'Restaurant'}
                          {r.price_avg != null ? ` · ~$${r.price_avg}` : ''}
                        </p>
                      </div>
                      <Icon name="heart" size={18} filled className="text-primary" />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* Sign out — MOBILE ONLY. At ≥md this lives in the sidebar rail's
              AccountMenu, but that rail is hidden below `md`, so this is the only
              way out of the app at phone width. */}
          <div className="border-t border-border pt-5 md:hidden">
            {/* Light-red fill + darker red text (matches the "disliked" pill).
                Confirms before acting. */}
            <Button
              variant="danger-subtle"
              fullWidth
              onClick={() => setConfirmingSignOut(true)}
            >
              Sign out
            </Button>
          </div>
        </motion.div>

        {/* Sign-out confirmation — mirrors the "Leave group?" modal. */}
        <Modal
          open={confirmingSignOut}
          onClose={() => (signingOut ? undefined : setConfirmingSignOut(false))}
          title="Sign out?"
          size="sm"
        >
          <div className="flex flex-col gap-5">
            <p className="text-body text-text-muted">
              You'll be signed out of GrubChat and returned to the login screen.
              Your saved profile and groups stay put — just sign back in anytime.
            </p>
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => setConfirmingSignOut(false)}
                disabled={signingOut}
              >
                Cancel
              </Button>
              <Button variant="danger" onClick={() => void confirmSignOut()} isLoading={signingOut}>
                Sign out
              </Button>
            </div>
          </div>
        </Modal>

        {/* Clears the fixed tab bar so the last row isn't trapped under it. */}
        <TabBarSpacer />
      </div>

      <BottomTabBar />
    </motion.div>
  )
}

function Section({
  label,
  children,
  variants,
}: {
  label: string
  children: React.ReactNode
  // Set by the page for the web-only staggered reveal; omitted on mobile /
  // reduced-motion so the section renders statically.
  variants?: Variants
}) {
  return (
    <motion.section className="flex flex-col gap-3" variants={variants}>
      <h3 className="text-overline font-semibold uppercase tracking-wide text-text-subtle">
        {label}
      </h3>
      {children}
    </motion.section>
  )
}

function InfoRow({
  icon,
  title,
  value,
}: {
  icon: 'wallet' | 'map-pin'
  title: string
  value: string
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-4">
      <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-surface-sunken text-primary">
        <Icon name={icon} size={16} />
      </span>
      <div>
        <p className="text-body font-semibold text-text">{title}</p>
        <p className="text-body text-text-muted">{value}</p>
      </div>
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-input border border-dashed border-border bg-surface-sunken px-4 py-3 text-body text-text-muted">
      {children}
    </p>
  )
}
