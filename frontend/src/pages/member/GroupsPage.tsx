import { useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { Button, Icon } from '@/components/ui'
import { makeFloat } from '@/lib/motion'
import { GroupsSidebar } from '@/components/session/GroupsSidebar'
import { NewGroupModal } from '@/components/session/NewGroupModal'
import { useNavStore } from '@/stores/navStore'
import { useGroupsStore } from '@/stores/groupsStore'
import { memberColor } from '@/constants/memberColors'

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
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-pill text-[10px] font-semibold text-white ${bg[colorClass]}`}
    >
      {name[0]}
    </span>
  )
}

// Post-auth landing for users with no groups: the SAME groups sidebar on the
// left (its "+" and the hero CTAs both create a group) plus a marketing-style
// filler pane on the right, mirroring the no-groups Figma reference.
export function EmptyGroupsPage() {
  const reduce = useReducedMotion()
  // Gentle idle float on the hero icon. Typed as `object` (matching BrandPanel's
  // FloatCard) so the string easing spreads cleanly onto the motion element.
  const heroFloat: object = makeFloat(!!reduce)(0)
  const go = useNavStore((s) => s.go)
  const setGroup = useNavStore((s) => s.setGroup)
  const addGroup = useGroupsStore((s) => s.addGroup)

  const [modalOpen, setModalOpen] = useState(false)
  const [creating, setCreating] = useState(false)

  // Same create flow as the sidebar: create via the store, select it, open chat.
  const handleCreate = async (name: string, memberIds: number[]) => {
    setCreating(true)
    try {
      const group = await addGroup(name, memberIds)
      setGroup(group.id)
      go('group-chat')
      setModalOpen(false)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="flex h-screen overflow-hidden bg-surface-raised">
      {/* Same sidebar as the group-chat context (shows the empty group list) */}
      <GroupsSidebar />

      {/* Marketing filler pane */}
      <div className="flex flex-1 flex-col overflow-y-auto bg-surface-raised">
        {/* Hero */}
        <section className="flex flex-col items-center border-b border-border px-8 pb-12 pt-16 text-center">
          <motion.span
            {...heroFloat}
            className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-surface-inverse text-white shadow-lg"
          >
            <Icon name="utensils" size={32} />
          </motion.span>
          <h1 className="font-display text-display font-bold tracking-tight text-text">
            Find restaurants
            <br />
            your whole group loves
          </h1>
          <p className="mt-3 max-w-md text-item-title leading-relaxed text-text-muted">
            Everyone tells their own AI agent what they want. GrubGroup finds the one restaurant
            that works for all of you.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button
              variant="primary"
              leftIcon={<Icon name="plus" size={16} />}
              onClick={() => setModalOpen(true)}
            >
              Create a group
            </Button>
            <Button variant="ghost" className="border border-border-strong" onClick={() => setModalOpen(true)}>
              Join with a link
            </Button>
          </div>
        </section>

        {/* How it works */}
        <section className="border-b border-border px-8 py-10">
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
        <section className="border-b border-border px-8 py-10">
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
        <section className="px-8 py-10">
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
                    <p className="text-caption font-bold text-primary">{p.score}%</p>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {p.tags.map((t) => (
                      <span
                        key={t}
                        className="flex items-center gap-1 rounded-pill bg-success/10 px-2 py-0.5 text-caption font-medium text-success"
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
            <Button variant="primary" onClick={() => setModalOpen(true)}>
              Get started — it's free
            </Button>
          </div>
        </section>
      </div>

      <NewGroupModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSubmit={handleCreate}
        pending={creating}
      />
    </div>
  )
}
