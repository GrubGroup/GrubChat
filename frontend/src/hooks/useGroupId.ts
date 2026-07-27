import { useParams } from 'react-router'

// The selected group (chat room) read from the URL — `/groups/:groupId`. Replaces
// the old navStore.groupId, so the URL is the single source of truth for which room
// the user is in.
//
// useParams yields strings; every store selector is keyed by number, so coerce here.
// A malformed id (`/groups/abc`) yields NaN, which is safe by construction: the
// keyed stores fall back to their frozen empty slice, and `NaN > 0` is false, so the
// membership check in GroupChatPage redirects instead of rendering a broken room.
// 0 is the no-group sentinel (real ids are positive).
export function useGroupId(): number {
  const { groupId } = useParams()
  return Number(groupId)
}
