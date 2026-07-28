import { Navigate } from 'react-router'
import { AppSplash } from '@/components/layout/AppSplash'
import { GroupsPage } from './GroupsPage'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useGroupsStore, mostRecentGroup } from '@/stores/groupsStore'
import { toSlugId } from '@/utils/slug'

// The /groups index — "take me to my groups" with no specific one named. Lands the
// user wherever the post-auth forward would: their most recently active chat, or the
// empty-state when they have none. Reuses mostRecentGroup so "most recent" means the
// same thing here as it does in PublicOnly and AuthForm.
//
// This is also the bounce target when a URL names a group the user isn't in, so it
// has to resolve to something real rather than a dead end. RequireAuth owns the
// fetch; this only decides where to go once the list has landed.
export function GroupsIndex() {
  const isMobile = useIsMobile()
  const groups = useGroupsStore((s) => s.groups)
  const loaded = useGroupsStore((s) => s.loaded)

  // Don't decide before the list arrives — an empty-but-unloaded list would send a
  // user who HAS groups to the empty-state.
  if (!loaded) return <AppSplash />

  const latest = mostRecentGroup(groups)
  // Desktop: the sidebar carries the group list beside the chat, so /groups just
  // forwards to the most recent chat. `replace` keeps /groups out of the history
  // stack, so Back doesn't land on a URL that immediately redirects again. On
  // mobile the tab root IS the list (a chat is a level deeper), so we render the
  // groups home instead of redirecting straight into a chat.
  if (!isMobile && latest) {
    return <Navigate to={`/groups/${toSlugId(latest.name, latest.id)}`} replace />
  }

  // GroupsPage shows the list on mobile (or the zero-state marketing when there are
  // no groups — the desktop empty-state too).
  return <GroupsPage />
}
