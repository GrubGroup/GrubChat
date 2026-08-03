// Shared budget formatting, and the one place the "no ceiling" encoding is
// spelled out for the client.
//
// A budget is a CEILING — what a diner is willing to spend UP TO — and `0` is
// the sentinel for "they set no ceiling at all". It mirrors
// `backend/ai_service/app/ai/budget.py` (`NO_CAP`), which is what the session
// chat writes when a member answers "I'm flexible" and what the onboarding
// "Flexible" band saves. A member on NO_CAP contributes no ceiling to the group
// recommendation: their saved profile budget is ignored, and they neither
// tighten nor loosen anyone else's picks.
//
// NO_CAP (0) is distinct from `null`, which means "the budget question has not
// been answered yet" — null still falls back to the saved profile budget, 0 does
// not. Keep the two apart everywhere.
export const NO_CAP_BUDGET = 0

/** True when a stored budget max means "no ceiling" rather than a real cap. */
export function isFlexibleBudget(max: number | null | undefined): boolean {
  return max != null && max <= NO_CAP_BUDGET
}

/**
 * Human-readable label for a (min, max) budget pair.
 *
 * Renders NO_CAP as "Flexible", a full range as "$15–25", a lone bound as
 * "Up to $25" / "From $15", and '' when neither bound is set (not answered yet).
 *
 * The flexible branch MUST come first: NO_CAP is stored as a real 0, so any
 * ordering that checks the numbers first renders a flexible member as "$0–0".
 *
 * `perPerson` appends " per person" — never to "Flexible" or to the empty
 * result, where the suffix reads oddly.
 */
export function formatBudget(
  min: number | null | undefined,
  max: number | null | undefined,
  opts: { perPerson?: boolean } = {},
): string {
  if (isFlexibleBudget(max)) return 'Flexible'

  let core = ''
  if (min != null && max != null) core = `$${min}–${max}`
  else if (max != null) core = `Up to $${max}`
  else if (min != null) core = `From $${min}`

  if (!core) return ''
  return opts.perPerson ? `${core} per person` : core
}
