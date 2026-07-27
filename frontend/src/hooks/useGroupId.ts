import { useParams } from 'react-router'
import { idFromSlug } from '@/utils/slug'

// The selected group (chat room) read from the URL — `/groups/:groupId`. The param
// is a readable slug with the numeric id at its tail (`foodie-friends-42`), but a
// bare `42` (legacy link) resolves identically — only the trailing id is trusted.
// Replaces the old navStore.groupId, so the URL is the single source of truth for
// which room the user is in.
//
// Every store selector is keyed by number, so coerce here. A malformed id
// (`/groups/abc`) yields NaN, which is safe by construction: the keyed stores fall
// back to their frozen empty slice, and `NaN > 0` is false, so the membership check
// in GroupChatPage redirects instead of rendering a broken room.
// 0 is the no-group sentinel (real ids are positive).
export function useGroupId(): number {
  const { groupId } = useParams()
  return idFromSlug(groupId)
}
