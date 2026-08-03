import { useEffect } from 'react'
import type { GroupLastMessage } from '@/types'
import { getSocket } from '@/lib/socket'
import { useAuthStore } from '@/stores/authStore'
import { useGroupsStore } from '@/stores/groupsStore'

// App-level group-membership sync. Unlike useSocket (scoped to one open group), this
// stays mounted for the whole signed-in session and listens on the shared singleton
// socket for membership changes: the gateway emits `group:added` / `group:removed` to
// the user's per-user room whenever they're added to or removed from a group. On
// either, we reload the group list so the sidebar reflects it without a manual
// refresh — mirroring the `session:confirmed → eventListStore.load()` pattern in
// useSocket. It also listens for `group:preview` to patch a group's last-message
// preview live when a message arrives in a group the user isn't viewing. No-op
// while signed out (getSocket() returns null).
export function useGroupSync() {
  const name = useAuthStore((s) => s.user?.display_name ?? s.user?.username)
  const userId = useAuthStore((s) => s.user?.id)

  useEffect(() => {
    if (!userId) return
    const socket = getSocket({ name: name ?? undefined })
    if (!socket) return

    const reload = () => {
      void useGroupsStore.getState().load()
    }
    socket.on('group:added', reload)
    socket.on('group:removed', reload)

    // A message landed in some group — patch its sidebar preview + sort order live,
    // even for a group this user isn't currently viewing (they're not in its chat
    // room, so the chat:message never reaches them).
    const applyPreview = (p: { groupId: number; last_message: GroupLastMessage }) => {
      useGroupsStore.getState().applyPreview(p.groupId, p.last_message)
    }
    socket.on('group:preview', applyPreview)

    return () => {
      socket.off('group:added', reload)
      socket.off('group:removed', reload)
      socket.off('group:preview', applyPreview)
    }
  }, [userId, name])
}
