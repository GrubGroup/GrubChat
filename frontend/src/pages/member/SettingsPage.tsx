import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { motion, useReducedMotion } from 'framer-motion'
import { Button, Icon, Input } from '@/components/ui'
import { EASE } from '@/lib/motion'
import { changeEmail, changePassword, linkSocial } from '@/lib/authClient'
import { fetchAuthMethods, type AuthMethods } from '@/api/authApi'
import { useAuthStore } from '@/stores/authStore'
import { cn } from '@/utils/cn'

// Account settings screen. Mirrors the "Account settings" wireframe (Account /
// Connected accounts / Danger zone) and reuses the full-page shell from
// ProfilePage. Edit email and change password are wired to Better Auth (via the
// gateway's /api/auth/* endpoints). Google-only accounts have no password
// credential, so those two controls are greyed out for them. The Connected
// accounts row is state-driven: it shows Google as connected only when actually
// linked, otherwise offers a working "Link Google account" OAuth flow (there is
// no disconnect — unlinking would risk locking a Google-only account out). Delete
// remains a visual stub (out of scope for now).
export function SettingsPage() {
  const reduce = useReducedMotion()
  const navigate = useNavigate()
  const location = useLocation()
  const user = useAuthStore((s) => s.user)
  const patchUser = useAuthStore((s) => s.patchUser)

  // Which auth providers this account has. Email/password lives on a 'credential'
  // provider (→ authMethods.password); Google-only accounts can't change email or
  // password, so we grey those controls out. Default false (while loading / on
  // error) so a Google user never briefly sees editable controls.
  const [authMethods, setAuthMethods] = useState<AuthMethods | null>(null)
  const canEditCredentials = authMethods?.password === true
  const authMethodsLoaded = authMethods !== null
  const googleConnected = authMethods?.google === true

  useEffect(() => {
    const email = user?.email
    if (!email) return
    let active = true
    fetchAuthMethods(email)
      .then((m) => {
        if (active) setAuthMethods(m)
      })
      .catch(() => {
        /* leave null → controls stay greyed; a settings edit can retry on reload */
      })
    return () => {
      active = false
    }
  }, [user?.email])

  // Email editor state.
  const [editingEmail, setEditingEmail] = useState(false)
  const [email, setEmail] = useState('')
  const [emailSaving, setEmailSaving] = useState(false)
  const [emailError, setEmailError] = useState<string | null>(null)
  const [emailSaved, setEmailSaved] = useState(false)

  // Password editor state.
  const [editingPassword, setEditingPassword] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [pwSaving, setPwSaving] = useState(false)
  const [pwError, setPwError] = useState<string | null>(null)
  const [pwSaved, setPwSaved] = useState(false)

  // Google account linking. linkSocial redirects the browser to Google's consent
  // screen (like signIn.social), returning to /settings — so on success the page
  // navigates away and only errors surface here.
  const [linking, setLinking] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)

  const linkGoogle = async () => {
    setLinkError(null)
    setLinking(true)
    const { error } = await linkSocial({
      provider: 'google',
      callbackURL: `${window.location.origin}/settings`,
    })
    if (error) {
      setLinking(false)
      setLinkError('Could not start Google linking. Please try again.')
    }
  }

  // Better Auth's listAccounts doesn't return the provider email; linking is by
  // same-email here, so the account email is the connected Google address.
  const connectedEmail = user?.email ?? 'you@example.com'

  // Back returns wherever the user came from. A 'default' location key means this
  // was the entry point (deep link or fresh reload), so fall through to home
  // rather than leaving the site. (Same rule as ProfilePage.)
  const goBack = () =>
    location.key === 'default' ? navigate('/groups') : navigate(-1)

  const openEmailEditor = () => {
    setEmail(user?.email ?? '')
    setEmailError(null)
    setEmailSaved(false)
    setEditingEmail(true)
  }

  const cancelEmail = () => {
    setEditingEmail(false)
    setEmailError(null)
  }

  const saveEmail = async () => {
    setEmailError(null)
    const next = email.trim()
    if (!next.includes('@')) {
      setEmailError('Enter a valid email address.')
      return
    }
    if (next === (user?.email ?? '')) {
      setEditingEmail(false)
      return
    }
    setEmailSaving(true)
    // Better Auth client methods resolve with { data, error } (no throw).
    const { error } = await changeEmail({ newEmail: next })
    setEmailSaving(false)
    if (error) {
      setEmailError(error.message ?? 'Could not update your email. Please try again.')
      return
    }
    // Reflect the change immediately; the useSession refetch on /change-email also
    // re-syncs the store via RootLayout, so this just avoids a flicker.
    patchUser({ email: next })
    setEditingEmail(false)
    setEmailSaved(true)
  }

  const openPasswordEditor = () => {
    setCurrentPassword('')
    setNewPassword('')
    setConfirmPassword('')
    setPwError(null)
    setPwSaved(false)
    setEditingPassword(true)
  }

  const cancelPassword = () => {
    setEditingPassword(false)
    setPwError(null)
  }

  const savePassword = async () => {
    setPwError(null)
    if (!currentPassword) {
      setPwError('Enter your current password.')
      return
    }
    if (newPassword.length < 8) {
      setPwError('New password must be at least 8 characters.')
      return
    }
    if (newPassword !== confirmPassword) {
      setPwError('New passwords do not match.')
      return
    }
    setPwSaving(true)
    const { error } = await changePassword({
      currentPassword,
      newPassword,
      revokeOtherSessions: false,
    })
    setPwSaving(false)
    if (error) {
      setPwError(error.message ?? 'Could not update your password. Please try again.')
      return
    }
    setCurrentPassword('')
    setNewPassword('')
    setConfirmPassword('')
    setEditingPassword(false)
    setPwSaved(true)
  }

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
                    onChange={(e) => {
                      setEmail(e.target.value)
                      if (emailError) setEmailError(null)
                    }}
                    error={emailError ?? undefined}
                    placeholder="you@example.com"
                  />
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={cancelEmail} disabled={emailSaving}>
                      Cancel
                    </Button>
                    <Button variant="primary" size="sm" onClick={saveEmail} isLoading={emailSaving}>
                      Save
                    </Button>
                  </div>
                </div>
              ) : (
                <SettingRow
                  label="Email"
                  value={user?.email ?? '—'}
                  actionLabel="Edit"
                  onAction={openEmailEditor}
                  actionDisabled={!canEditCredentials}
                  hint={
                    !canEditCredentials ? (
                      <span className="text-xs text-text-muted">Managed by Google</span>
                    ) : emailSaved ? (
                      <span className="text-xs text-success">Email updated</span>
                    ) : undefined
                  }
                />
              )}

              <div className="h-px bg-border" />

              {/* Password — view / inline change */}
              {editingPassword ? (
                <div className="flex flex-col gap-3 px-4 py-4">
                  <Input
                    label="Current password"
                    type="password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    placeholder="••••••••"
                  />
                  <Input
                    label="New password"
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="At least 8 characters"
                  />
                  <Input
                    label="Confirm new password"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Re-enter new password"
                  />
                  {pwError && <p className="text-sm text-error">{pwError}</p>}
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={cancelPassword} disabled={pwSaving}>
                      Cancel
                    </Button>
                    <Button variant="primary" size="sm" onClick={savePassword} isLoading={pwSaving}>
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
                  onAction={openPasswordEditor}
                  actionDisabled={!canEditCredentials}
                  hint={
                    !canEditCredentials ? (
                      <span className="text-xs text-text-muted">Managed by Google</span>
                    ) : pwSaved ? (
                      <span className="text-xs text-success">Password updated</span>
                    ) : undefined
                  }
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
                    {!authMethodsLoaded ? (
                      <span className="text-xs text-text-muted">Checking…</span>
                    ) : googleConnected ? (
                      <span className="text-xs text-success">Connected · {connectedEmail}</span>
                    ) : (
                      <span className="text-xs text-text-muted">Not connected</span>
                    )}
                    {linkError && <span className="text-xs text-error">{linkError}</span>}
                  </div>
                </div>
                {authMethodsLoaded && !googleConnected && (
                  <button
                    onClick={linkGoogle}
                    disabled={linking}
                    className="shrink-0 text-sm font-semibold text-primary hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Link Google account
                  </button>
                )}
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
    </motion.div>
  )
}

// A read-mode settings row: label + value on the left, an inline text action
// (orange for edits) on the right. When `actionDisabled` the action is greyed and
// non-interactive (e.g. Google-only accounts can't change email/password).
function SettingRow({
  label,
  value,
  valueClassName,
  actionLabel,
  onAction,
  actionDisabled = false,
  hint,
}: {
  label: string
  value: string
  valueClassName?: string
  actionLabel: string
  onAction: () => void
  actionDisabled?: boolean
  hint?: ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-4">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm text-text-muted">{label}</span>
        <span className={cn('text-sm font-semibold text-text', valueClassName)}>{value}</span>
        {hint}
      </div>
      <button
        type="button"
        onClick={actionDisabled ? undefined : onAction}
        disabled={actionDisabled}
        className={cn(
          'shrink-0 text-sm font-semibold',
          actionDisabled
            ? 'cursor-not-allowed text-text-muted'
            : 'text-primary hover:opacity-80',
        )}
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
