// Shared password strength rules. Used by sign-up (AuthForm) and the change-password
// editor (SettingsPage) so the same requirements are enforced and surfaced everywhere.
// The gateway's Better Auth still validates server-side; this is the client-side gate
// and the visible checklist that guides the user before they submit.

export interface PasswordRule {
  /** Stable key for React lists. */
  key: string
  /** Human-readable requirement, phrased as the passing state. */
  label: string
  /** True when `password` satisfies this rule. */
  test: (password: string) => boolean
}

export const PASSWORD_RULES: PasswordRule[] = [
  { key: 'length', label: 'At least 8 characters', test: (p) => p.length >= 8 },
  { key: 'uppercase', label: 'One uppercase letter', test: (p) => /[A-Z]/.test(p) },
  { key: 'lowercase', label: 'One lowercase letter', test: (p) => /[a-z]/.test(p) },
  { key: 'number', label: 'One number', test: (p) => /[0-9]/.test(p) },
  {
    key: 'special',
    label: 'One special character',
    test: (p) => /[^A-Za-z0-9]/.test(p),
  },
]

// True only when every rule passes.
export function isPasswordValid(password: string): boolean {
  return PASSWORD_RULES.every((rule) => rule.test(password))
}
