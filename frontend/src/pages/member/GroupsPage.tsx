import { motion, useReducedMotion } from 'framer-motion'
import { Button, BrandMark, Icon } from '@/components/ui'
import { makeFloat } from '@/lib/motion'
import { BottomTabBar, TabBarSpacer } from '@/components/layout/BottomTabBar'
import { MobileHeader } from '@/components/layout/MobileHeader'
import { GroupList } from '@/components/session/GroupList'
import { GroupsSidebar } from '@/components/session/GroupsSidebar'
import { NewGroupModal } from '@/components/session/NewGroupModal'
import { useCreateGroup } from '@/hooks/useCreateGroup'
import { useGroupsStore } from '@/stores/groupsStore'
import { memberColor } from '@/constants/memberColors'
import { cn } from '@/utils/cn'

// "How it works" steps — emoji tiles, mirroring the no-groups Figma reference.
const HOW_IT_WORKS: { emoji: string; title: string; body: string }[] = [
  {
    emoji: '💬',
    title: 'Chat with your group',
    body: 'Start a session from any group chat. Everyone gets a private conversation with their own AI food agent.',
  },
  {
    emoji: '🎤',
    title: 'Tell it what you want',
    body: 'Talk or type — share your mood, budget, dietary needs, and location. The agent remembers everything from your profile.',
  },
  {
    emoji: '🍽️',
    title: 'One perfect pick',
    body: 'The AI finds restaurants that work for your whole group at once. Vote on the top picks and confirm in seconds.',
  },
]

// Scattered member preference chips for the "works for every group" band.
const PREFERENCE_CHIPS: { userId: number; name: string; pref: string }[] = [
  { userId: 4, name: 'Maya', pref: '🌱 Vegan' },
  { userId: 1, name: 'Dev', pref: '🚫 No tree nuts' },
  { userId: 2, name: 'Sofia', pref: '🅿️ Needs parking' },
  { userId: 6, name: 'Tomás', pref: '💸 Under $20pp' },
]

// Community picks for the social-proof band.
const COMMUNITY_PICKS: { name: string; score: number; tags: string[] }[] = [
  { name: 'The Farmhouse Table', score: 94, tags: ['Vegan', 'Nut-free'] },
  { name: 'Noodle & Co', score: 88, tags: ['Nut-free'] },
  { name: 'Souvla', score: 85, tags: ['Vegan', 'GF'] },
]

// Small colored avatar initial, matching the member-identity colors.
function MemberDot({ userId, name }: { userId: number; name: string }) {
  const colorClass = memberColor(userId)
  const bg: Record<string, string> = {
    'member-purple': 'bg-member-purple',
    'member-pink': 'bg-member-pink',
    'member-terracotta': 'bg-member-terracotta',
    'member-green': 'bg-member-green',
    'member-blue': 'bg-member-blue',
    'member-amber': 'bg-member-amber',
  }
  return (
    <span
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-pill text-[10px] font-semibold text-on-member ${bg[colorClass]}`}
    >
      {name[0]}
    </span>
  )
}

// The Groups home. At ≥md it's the groups sidebar plus a marketing-style filler
// pane, mirroring the no-groups Figma reference. Below `md` it is the WhatsApp-
// style ROOT of the groups tab: the search + list fills the screen, a group chat
// is a level deeper (its back chevron returns here), and the marketing pitch
// stands in only while the list is genuinely empty.
export function GroupsPage() {
  const reduce = useReducedMotion()
  // Gentle idle float on the hero icon. Typed as `object` (matching BrandPanel's
  // FloatCard) so the string easing spreads cleanly onto the motion element.
  const heroFloat: object = makeFloat(!!reduce)(0)
  const groups = useGroupsStore((s) => s.groups)
  // Same create flow every host of the groups list uses (sidebar "+", the mobile
  // root's "+").
  const { modalOpen, openModal, closeModal, creating, handleCreate } = useCreateGroup()
  const hasGroups = groups.length > 0

  // The "+" that opens the create-group modal — identical in both mobile headers
  // below, and in the desktop sidebar's header slot.
  const newGroupButton = (
    <button
      onClick={openModal}
      aria-label="New group"
      // tap-target grows the hit area to 44px; the 28px pill is unchanged.
      className="tap-target flex h-7 w-7 items-center justify-center rounded-lg bg-surface-inverse text-on-inverse transition-opacity active:opacity-90"
    >
      <Icon name="plus" size={14} />
    </button>
  )

  return (
    <div className="flex h-dvh overflow-hidden bg-surface-raised">
      {/* Same sidebar as the group-chat context (shows the empty group list) */}
      <GroupsSidebar />

      {/* MOBILE list root (<md) — the tab's own screen: search, every group, and
          the "+". The SAME GroupList the desktop sidebar renders, so rows, search
          and live sorting can't drift between the two. Swapped for the pitch pane
          below while the list is empty, since a bare "No groups yet." would waste
          the whole screen. */}
      <div
        className={cn(
          'w-full min-w-0 flex-col overflow-y-auto bg-surface-panel md:hidden',
          hasGroups ? 'flex' : 'hidden',
        )}
      >
        <MobileHeader brand title="Groups" actions={newGroupButton} />
        <GroupList />
        <TabBarSpacer />
      </div>

      {/* Marketing filler pane — the desktop right column at every width; below
          `md` it's the zero state only. */}
      <div
        className={cn(
          'min-w-0 flex-1 flex-col overflow-y-auto bg-surface-raised',
          hasGroups ? 'hidden md:flex' : 'flex',
        )}
      >
        {/* MOBILE (<md): the sidebar that normally carries the header is hidden,
            so the tab root's own header appears here. */}
        <MobileHeader className="md:hidden" brand title="Groups" actions={newGroupButton} />

        {/* Hero */}
        <section
          className={cn(
            'flex flex-col items-center border-b border-border px-4 pb-10 pt-10 text-center',
            'sm:px-8 sm:pb-12 sm:pt-16',
          )}
        >
          <motion.span {...heroFloat} className="mb-5 text-text drop-shadow-lg">
            <BrandMark size={64} />
          </motion.span>
          <h1 className="font-display text-section-title font-bold tracking-tight text-text sm:text-display">
            Find restaurants
            <br />
            your whole group loves
          </h1>
          <p className="mt-3 max-w-md text-body leading-relaxed text-text-muted sm:text-item-title">
            Everyone tells their own AI agent what they want. GrubChat finds the one restaurant
            that works for all of you.
          </p>
          {/* Stacked full-width below `sm` — two side-by-side buttons plus a gap
              don't fit 390px minus padding without one of them wrapping oddly. */}
          <div className="mt-8 flex w-full max-w-xs flex-col items-stretch gap-3 sm:max-w-none sm:flex-row sm:flex-wrap sm:items-center sm:justify-center">
            <Button
              variant="primary"
              leftIcon={<Icon name="plus" size={16} />}
              onClick={openModal}
            >
              Create a group
            </Button>
            <Button variant="ghost" className="border border-border-strong" onClick={openModal}>
              Join with a link
            </Button>
          </div>
        </section>

        {/* How it works */}
        <section className="border-b border-border px-4 py-10 sm:px-8">
          <p className="text-center text-overline font-semibold uppercase tracking-[0.1em] text-text-muted">
            How it works
          </p>
          <div className="mx-auto mt-6 grid max-w-2xl gap-8 sm:grid-cols-3">
            {HOW_IT_WORKS.map((s) => (
              <div key={s.title} className="flex flex-col gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-surface-panel text-xl">
                  {s.emoji}
                </span>
                <h3 className="text-item-title font-semibold text-text">{s.title}</h3>
                <p className="text-caption leading-relaxed text-text-muted">{s.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Works for every group */}
        <section className="border-b border-border px-4 py-10 sm:px-8">
          <p className="text-center text-overline font-semibold uppercase tracking-[0.1em] text-text-muted">
            Works for every group
          </p>
          <p className="mt-2 text-center text-caption text-text-muted">
            Dietary restrictions, budgets, and location preferences — handled automatically.
          </p>
          <div className="mx-auto mt-6 flex max-w-lg flex-wrap items-center justify-center gap-2.5">
            {PREFERENCE_CHIPS.map((c) => (
              <div
                key={c.name}
                className="flex items-center gap-2 rounded-2xl border border-border bg-surface-panel px-3 py-2"
              >
                <MemberDot userId={c.userId} name={c.name} />
                <div className="leading-tight">
                  <p className="text-caption font-semibold text-text">{c.name}</p>
                  <p className="text-caption text-text-muted">{c.pref}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Recent community picks */}
        <section className="px-4 py-10 sm:px-8">
          <p className="text-center text-overline font-semibold uppercase tracking-[0.1em] text-text-muted">
            Recent picks from the community
          </p>
          <div className="mx-auto mt-6 grid max-w-2xl gap-4 sm:grid-cols-3">
            {COMMUNITY_PICKS.map((p) => (
              <div
                key={p.name}
                className="overflow-hidden rounded-2xl border border-border bg-surface-raised shadow-sm"
              >
                <div className="h-28 w-full bg-surface-sunken" />
                <div className="p-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-caption font-semibold text-text">{p.name}</p>
                    <p className="text-caption font-bold text-primary-text">{p.score}%</p>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {p.tags.map((t) => (
                      <span
                        key={t}
                        className="flex items-center gap-1 rounded-pill bg-success/10 px-2 py-0.5 text-caption font-medium text-success-text"
                      >
                        <Icon name="check" size={10} /> {t}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-8 flex justify-center">
            <Button variant="primary" onClick={openModal}>
              Get started — it's free
            </Button>
          </div>
        </section>

        {/* Clears the fixed tab bar so the final CTA isn't under it. */}
        <TabBarSpacer />
      </div>

      <NewGroupModal
        open={modalOpen}
        onClose={closeModal}
        onSubmit={handleCreate}
        pending={creating}
      />

      <BottomTabBar />
    </div>
  )
}
