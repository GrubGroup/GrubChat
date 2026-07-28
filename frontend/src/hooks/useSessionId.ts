import { useParams } from 'react-router'

// The session the URL names — `/groups/:groupId/sessions/:sessionId`. Note this is
// for addressability, NOT lookup: session state is keyed by GROUP (a group has at
// most one open session), so pages read the store's activeSessionId and treat this
// value as the thing to validate against. That keeps one source of truth and avoids
// acting on an unvalidated URL id. NaN for a malformed param — see useGroupId.
export function useSessionId(): number {
  const { sessionId } = useParams()
  return Number(sessionId)
}
