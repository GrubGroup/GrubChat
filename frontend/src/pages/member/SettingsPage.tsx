import type { ReactNode } from 'react'
import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { motion, useReducedMotion } from 'framer-motion'
import { Button, Icon, Input, Modal } from '@/components/ui'
import { EASE } from '@/lib/motion'
import { useAuthStore } from '@/stores/authStore'
import { cn } from '@/utils/cn'

// Account settings screen. Mirrors the "Account settings" wireframe (Account /
// Connected accounts / Danger zone) and reuses the full-page shell from
// ProfilePage. This surface is intentionally NOT wired to any API: the inline
// editors and destructive actions are visual stubs — Save is disabled, the
// Disconnect confirm is a no-op, and Delete is a disabled button. See the
// account-settings plan for the rationale.
export function SettingsPage() {
  const reduce = useReducedMotion()
  const navigate = useNavigate()
  const location = useLocation()
  const user = useAuthStore((s) => s.user)

  // Inline-edit / dialog UI state (local only — nothing persists).
  const [editingEmail, setEditingEmail] = useState(false)
  const [email, setEmail] = useState(() => user?.email ?? '')
  const [editingPassword, setEditingPassword] = useState(false)
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false)

  // Illustrative connected-account address: the frontend has no connected-account
  // data, so we surface the signed-in email to match the wireframe's linked state.
  const connectedEmail = user?.email ?? 'you@example.com'

  // Back returns wherever the user came from. A 'default' location key means this
  // was the entry point (deep link or fresh reload), so fall through to home
  // rather than leaving the site. (Same rule as ProfilePage.)
  const goBack = () =>
    location.key === 'default' ? navigate('/groups') : navigate(-1)

  return (
    <motion.div
      className="h-screen overflow-y-auto bg-surface-raised"
      initial={{ opacity: 0, y: reduce ? 0 : 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduce ? 0.15 : 0.3, ease: EASE }}
    >
      <div className="mx-auto max-w-3xl">
        {/* Header bar */}
        <div className="border-b border-border px-8 py-6">
          <button
            onClick={goBack}
            className="mb-2 flex items-center gap-1 text-sm text-text-muted hover:text-text"
          >
            <Icon name="chevron-left" size={14} /> Back
          </button>
          <h1 className="font-display text-2xl font-bold text-text">Account settings</h1>
          <p className="text-sm text-text-muted">
            Manage your login, notifications, and connected accounts
          </p>
        </div>

        <div className="flex flex-col gap-8 px-8 py-6">
          {/* ACCOUNT */}
          <Section label="Account">
            <div className="overflow-hidden rounded-card border border-border">
              {/* Email — view / inline edit */}
              {editingEmail ? (
                <div className="flex flex-col gap-3 px-4 py-4">
                  <Input
                    label="Email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                  />
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setEmail(user?.email ?? '')
                        setEditingEmail(false)
                      }}
                    >
                      Cancel
                    </Button>
                    {/* Stub: not wired to any API, so saving is disabled. */}
                    <Button variant="primary" size="sm" disabled>
                      Save
                    </Button>
                  </div>
                </div>
              ) : (
                <SettingRow
                  label="Email"
                  value={user?.email ?? '—'}
                  actionLabel="Edit"
                  onAction={() => setEditingEmail(true)}
                />
              )}

              <div className="h-px bg-border" />

              {/* Password — view / inline change */}
              {editingPassword ? (
                <div className="flex flex-col gap-3 px-4 py-4">
                  <Input label="Current password" type="password" placeholder="••••••••" />
                  <Input
                    label="New password"
                    type="password"
                    placeholder="At least 8 characters"
                  />
                  <Input
                    label="Confirm new password"
                    type="password"
                    placeholder="Re-enter new password"
                  />
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setEditingPassword(false)}>
                      Cancel
                    </Button>
                    {/* Stub: not wired to any API, so saving is disabled. */}
                    <Button variant="primary" size="sm" disabled>
                      Save
                    </Button>
                  </div>
                </div>
              ) : (
                <SettingRow
                  label="Password"
                  value="••••••••••"
                  valueClassName="tracking-widest"
                  actionLabel="Change"
                  onAction={() => setEditingPassword(true)}
                />
              )}
            </div>
          </Section>

          {/* CONNECTED ACCOUNTS */}
          <Section label="Connected accounts">
            <div className="overflow-hidden rounded-card border border-border">
              <div className="flex items-center justify-between gap-3 px-4 py-4">
                <div className="flex items-center gap-3">
                  <GoogleGlyph />
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-semibold text-text">Google</span>
                    <span className="text-xs text-success">Connected · {connectedEmail}</span>
                  </div>
                </div>
                <button
                  onClick={() => setConfirmingDisconnect(true)}
                  className="text-sm font-medium text-text-muted hover:text-text"
                >
                  Disconnect
                </button>
              </div>
            </div>
          </Section>

          {/* DANGER ZONE */}
          <Section label="Danger zone">
            <div className="flex items-center justify-between gap-3 rounded-card border border-error/30 bg-error/[0.05] px-4 py-4">
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-semibold text-error">Delete account</span>
                <span className="text-sm text-text-muted">
                  Permanently remove your profile, sessions, and saved preferences
                </span>
              </div>
              {/* Stub: destructive delete is not wired — the button is disabled. */}
              <button
                type="button"
                disabled
                className="shrink-0 rounded-pill border border-error px-4 py-1.5 text-sm font-semibold text-error transition-colors hover:bg-error/5 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Delete
              </button>
            </div>
          </Section>
        </div>
      </div>

      {/* Disconnect confirmation — the flow is present but the confirm is a no-op
          (no API call), matching the visual-stub scope. */}
      <Modal
        open={confirmingDisconnect}
        onClose={() => setConfirmingDisconnect(false)}
        title="Disconnect Google?"
        size="sm"
      >
        <div className="flex flex-col gap-5">
          <p className="text-body text-text-muted">
            You'll need to sign in with your email and password next time. This won't delete your
            account.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmingDisconnect(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => setConfirmingDisconnect(false)}>
              Disconnect
            </Button>
          </div>
        </div>
      </Modal>
    </motion.div>
  )
}

// A read-mode settings row: label + value on the left, an inline text action
// (orange for edits) on the right. Matches the wireframe's Account card rows.
function SettingRow({
  label,
  value,
  valueClassName,
  actionLabel,
  onAction,
}: {
  label: string
  value: string
  valueClassName?: string
  actionLabel: string
  onAction: () => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-4">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm text-text-muted">{label}</span>
        <span className={cn('text-sm font-semibold text-text', valueClassName)}>{value}</span>
      </div>
      <button
        onClick={onAction}
        className="shrink-0 text-sm font-semibold text-primary hover:opacity-80"
      >
        {actionLabel}
      </button>
    </div>
  )
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
        {label}
      </h3>
      {children}
    </section>
  )
}

// Google's multi-color "G" brand mark. The shared Icon set has no Google glyph,
// and brand colors can't be expressed with the semantic theme tokens — so this
// inlines the official artwork (the one place raw hex is warranted).
function GoogleGlyph() {
  return (
    <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-surface-sunken">
      <svg viewBox="0 0 48 48" width={20} height={20} aria-hidden="true">
        <path
          fill="#EA4335"
          d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
        />
        <path
          fill="#4285F4"
          d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
        />
        <path
          fill="#FBBC05"
          d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
        />
        <path
          fill="#34A853"
          d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
        />
      </svg>
    </span>
  )
}
