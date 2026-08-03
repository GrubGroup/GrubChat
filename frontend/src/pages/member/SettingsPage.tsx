import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { motion, useReducedMotion, type Variants } from 'framer-motion'
import { Button, Icon, Input, Modal, PasswordChecklist } from '@/components/ui'
import { VoicePreviewButton } from '@/components/voice/VoicePreviewButton'
import { isPasswordValid } from '@/utils/password'
import { EASE } from '@/lib/motion'
import { changeEmail, changePassword, linkSocial } from '@/lib/authClient'
import { fetchAuthMethods, type AuthMethods } from '@/api/authApi'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useDeleteAccount } from '@/hooks/useSignOut'
import { useAuthStore } from '@/stores/authStore'
import { useVoicePrefStore } from '@/stores/voicePrefStore'
import { useThemeStore } from '@/stores/themeStore'
import { VOICE_OPTIONS } from '@/constants/voices'
import { THEME_OPTIONS, type Theme } from '@/constants/theme'
import type { IconName } from '@/components/ui'
import { cn } from '@/utils/cn'

// Web-only staggered reveal for the settings sections: the container cascades its
// children in one after another as the page pushes in. Applied only when `animate`
// is on (desktop, motion allowed); otherwise the sections render statically.
//
// `hidden` doubles as the EXIT: clicking Back animates the container back to
// `hidden`, so the same sections cascade out — in reverse order (`staggerDirection`
// -1) so it reads as the entrance played backwards. `when: 'afterChildren'` makes
// the container's onAnimationComplete wait for every section, which is what
// triggers the actual navigation (see the container below).
const sectionsContainer = {
  hidden: { transition: { staggerChildren: 0.05, staggerDirection: -1, when: 'afterChildren' } },
  show: { transition: { staggerChildren: 0.06, delayChildren: 0.08 } },
}
const sectionItem = {
  hidden: { opacity: 0, y: 12, transition: { duration: 0.25, ease: EASE } },
  show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: EASE } },
}

// Account settings screen. Mirrors the "Account settings" wireframe (Account /
// Connected accounts / Danger zone) and reuses the full-page shell from
// ProfilePage. Edit email and change password are wired to Better Auth (via the
// gateway's /api/auth/* endpoints). Google-only accounts have no password
// credential, so those two controls are greyed out for them. The Connected
// accounts row is state-driven: it shows Google as connected only when actually
// linked, otherwise offers a working "Link Google account" OAuth flow (there is
// no disconnect — unlinking would risk locking a Google-only account out). Delete
// account opens a confirmation modal and, on confirm, soft-deletes the account
// (DELETE /api/user) then runs the sign-out teardown.
export function SettingsPage() {
  const reduce = useReducedMotion()
  // Web only: at ≥md this page is PUSHED from the rail's account menu, so an
  // entrance fade/rise (and a staggered section reveal) reads as that push. Below
  // `md` it's reached from the profile tab and should paint instantly, matching
  // ProfilePage's convention — so gate the whole animation on desktop.
  const isMobile = useIsMobile()
  const animate = !isMobile && !reduce
  const navigate = useNavigate()
  const location = useLocation()
  const user = useAuthStore((s) => s.user)
  const patchUser = useAuthStore((s) => s.patchUser)

  // AI voice selection — the Cartesia voice the hands-free session agent speaks
  // with. Persisted per-device (voicePrefStore) and flows into the voice loop's
  // `start` frame, so a change takes effect on the next voice session.
  const voiceId = useVoicePrefStore((s) => s.voiceId)
  const setVoiceId = useVoicePrefStore((s) => s.setVoiceId)
  const selectedVoice = VOICE_OPTIONS.find((v) => v.id === voiceId)
  // A failed preview (TTS unconfigured, upstream busy) is reported here rather
  // than inside the button — the control row has no space for a message.
  const [voicePreviewError, setVoicePreviewError] = useState<string | null>(null)

  // Color theme — a per-device rendering preference (themeStore, persisted to
  // localStorage). Changing it re-applies immediately via the store's applyTheme
  // (toggles the `.dark` class on <html>); no reload needed.
  const theme = useThemeStore((s) => s.theme)
  const setTheme = useThemeStore((s) => s.setTheme)

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

  // Delete account. deleteAccount() performs the soft-delete then the full
  // sign-out teardown (clear stores + navigate to /login), so on success this
  // page unmounts. Only a server error surfaces here (the delete always succeeds
  // otherwise — any open session the user hosts is handed off or auto-closed);
  // its message is shown in the modal.
  const deleteAccount = useDeleteAccount()
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // Web-only exit: clicking Back fades/drops the page out (mirroring the entrance)
  // before we actually navigate, so the push in and the pop out feel symmetric.
  const [leaving, setLeaving] = useState(false)

  const openDeleteConfirm = () => {
    setDeleteError(null)
    setConfirmingDelete(true)
  }

  const handleDelete = async () => {
    setDeleteError(null)
    setDeleting(true)
    try {
      await deleteAccount()
      // On success the teardown navigates to /login and this unmounts.
    } catch (err) {
      setDeleting(false)
      setDeleteError(
        (err as { message?: string })?.message ??
          'Could not delete your account. Please try again.',
      )
    }
  }

  // Better Auth's listAccounts doesn't return the provider email; linking is by
  // same-email here, so the account email is the connected Google address.
  const connectedEmail = user?.email ?? 'you@example.com'

  // Back returns wherever the user came from. A 'default' location key means this
  // was the entry point (deep link or fresh reload), so fall through to home
  // rather than leaving the site. (Same rule as ProfilePage.)
  const doNavigateBack = () =>
    location.key === 'default' ? navigate('/groups') : navigate(-1)

  // On desktop, run the exit animation first and navigate when it finishes (see
  // onAnimationComplete below). On mobile / reduced-motion there's no entrance, so
  // Back should navigate instantly — animating the exit alone would feel lopsided.
  const goBack = () => {
    if (animate) setLeaving(true)
    else doNavigateBack()
  }

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
    if (!isPasswordValid(newPassword)) {
      setPwError('Your new password must meet all the requirements listed below.')
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
      // Root stays fully opaque throughout — its `bg-surface-raised` is the page
      // backdrop. Fading it out on exit revealed the (dark) app backdrop behind,
      // since the previous route isn't mounted yet. Only the content cascades out.
      initial={animate ? { opacity: 0, y: 8 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={animate ? { duration: 0.3, ease: EASE } : { duration: 0 }}
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

        <motion.div
          className="flex flex-col gap-8 px-8 py-6"
          variants={animate ? sectionsContainer : undefined}
          initial={animate ? 'hidden' : false}
          animate={animate ? (leaving ? 'hidden' : 'show') : false}
          onAnimationComplete={(def) => {
            // Fires for both directions; only the exit cascade ('hidden' while
            // leaving) should navigate.
            if (leaving && def === 'hidden') doNavigateBack()
          }}
        >
          {/* ACCOUNT */}
          <Section label="Account" variants={animate ? sectionItem : undefined}>
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
                  value={user?.email ?? 'Not set'}
                  actionLabel="Edit"
                  onAction={openEmailEditor}
                  actionDisabled={!canEditCredentials}
                  hint={
                    !canEditCredentials ? (
                      <span className="text-xs text-text-muted">Managed by Google</span>
                    ) : emailSaved ? (
                      <span className="text-xs text-success-text">Email updated</span>
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
                  {newPassword.length > 0 && <PasswordChecklist value={newPassword} />}
                  <Input
                    label="Confirm new password"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Re-enter new password"
                  />
                  {pwError && <p className="text-sm text-error-text">{pwError}</p>}
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
                      <span className="text-xs text-success-text">Password updated</span>
                    ) : undefined
                  }
                />
              )}
            </div>
          </Section>

          {/* CONNECTED ACCOUNTS */}
          <Section label="Connected accounts" variants={animate ? sectionItem : undefined}>
            <div className="overflow-hidden rounded-card border border-border">
              <div className="flex items-center justify-between gap-3 px-4 py-4">
                <div className="flex items-center gap-3">
                  <GoogleGlyph />
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-semibold text-text">Google</span>
                    {!authMethodsLoaded ? (
                      <span className="text-xs text-text-muted">Checking…</span>
                    ) : googleConnected ? (
                      <span className="text-xs text-success-text">Connected · {connectedEmail}</span>
                    ) : (
                      <span className="text-xs text-text-muted">Not connected</span>
                    )}
                    {linkError && <span className="text-xs text-error-text">{linkError}</span>}
                  </div>
                </div>
                {authMethodsLoaded && !googleConnected && (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={linkGoogle}
                    isLoading={linking}
                    className="shrink-0"
                  >
                    Link Google account
                  </Button>
                )}
              </div>
            </div>
          </Section>

          {/* APPEARANCE */}
          <Section label="Appearance" variants={animate ? sectionItem : undefined}>
            <div className="overflow-hidden rounded-card border border-border">
              <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface-sunken text-primary-text">
                    <Icon name="moon" size={18} />
                  </span>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-semibold text-text">Dark mode</span>
                    <span className="text-xs text-text-muted">
                      Follow your system setting, or force a light or dark theme
                    </span>
                  </div>
                </div>
                <ThemeSegmented value={theme} onChange={setTheme} />
              </div>
            </div>
          </Section>

          {/* AI SETTINGS */}
          <Section label="AI settings" variants={animate ? sectionItem : undefined}>
            <div className="overflow-hidden rounded-card border border-border">
              <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface-sunken text-primary-text">
                    <Icon name="speaker" size={18} />
                  </span>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-semibold text-text">Agent voice</span>
                    <span className="text-xs text-text-muted">
                      The voice your AI agent speaks with during voice sessions
                    </span>
                  </div>
                </div>
                {/* Preview sits to the LEFT of the picker: the point is to hear a
                    voice BEFORE committing to it, and a session is otherwise the
                    only place you'd find out what it sounds like. */}
                <div className="flex w-full items-center gap-2 sm:w-auto">
                  <VoicePreviewButton
                    voiceId={voiceId}
                    voiceName={selectedVoice?.name ?? 'the selected voice'}
                    onError={setVoicePreviewError}
                    className="shrink-0 border border-border bg-surface-sunken text-text"
                  />
                  <select
                    aria-label="Agent voice"
                    value={voiceId}
                    onChange={(e) => {
                      setVoiceId(e.target.value)
                      setVoicePreviewError(null)
                    }}
                    className="h-11 min-w-0 flex-1 rounded-input border border-border bg-surface-sunken px-3 text-text focus:outline-none focus:ring-2 focus:ring-focus-ring sm:flex-none sm:w-auto sm:min-w-56"
                  >
                    {VOICE_OPTIONS.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name} ({v.gender})
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {voicePreviewError && (
                <p className="px-4 pb-4 text-xs text-error-text" role="status">
                  {voicePreviewError}
                </p>
              )}
            </div>
          </Section>

          {/* DANGER ZONE */}
          <Section label="Danger zone" variants={animate ? sectionItem : undefined}>
            <div className="flex items-center justify-between gap-3 rounded-card border border-error/30 bg-error/[0.05] px-4 py-4">
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-semibold text-error-text">Delete account</span>
                <span className="text-sm text-text-muted">
                  Delete your account and remove yourself from all groups
                </span>
              </div>
              <Button
                variant="danger"
                size="sm"
                onClick={openDeleteConfirm}
                className="shrink-0"
              >
                Delete
              </Button>
            </div>
          </Section>
        </motion.div>
      </div>

      {/* Delete-account confirmation. Guard onClose while the request is in
          flight so the modal can't be dismissed mid-delete. */}
      <Modal
        open={confirmingDelete}
        onClose={() => (deleting ? undefined : setConfirmingDelete(false))}
        title="Delete account?"
        size="sm"
      >
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-3 text-body text-text-muted">
            <p>
              This deletes your account and signs you out. You'll be removed from all
              your groups, and you won't be able to log back in.
            </p>
            <p>
              Your past messages stay in group chats, and your username and email are
              freed up for future sign-ups.
            </p>
          </div>
          {deleteError && <p className="text-sm text-error-text">{deleteError}</p>}
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => setConfirmingDelete(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button variant="danger" onClick={handleDelete} isLoading={deleting}>
              Delete account
            </Button>
          </div>
        </div>
      </Modal>
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
      <Button
        variant="primary"
        size="sm"
        leftIcon={<Icon name="pencil" size={14} />}
        onClick={onAction}
        disabled={actionDisabled}
        className="shrink-0"
      >
        {actionLabel}
      </Button>
    </div>
  )
}

// 3-way segmented control for the color theme (System · Light · Dark), matching
// the wireframe. Each segment carries a visible TEXT label, so state never
// relies on the icon/color alone (WCAG); System = monitor, Light = sun, Dark =
// moon. The active segment is a raised filled pill; `aria-pressed` exposes
// selection to assistive tech.
const THEME_ICONS: Record<Theme, IconName> = { system: 'monitor', light: 'sun', dark: 'moon' }

function ThemeSegmented({
  value,
  onChange,
}: {
  value: Theme
  onChange: (theme: Theme) => void
}) {
  return (
    <div
      role="group"
      aria-label="Theme"
      className="inline-flex items-center gap-1 rounded-pill border border-border bg-surface-sunken p-1"
    >
      {THEME_OPTIONS.map((opt) => {
        const active = value === opt.value
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-pill px-3 py-1.5 text-xs font-semibold transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring',
              active
                ? 'bg-surface-raised text-text shadow-sm'
                : 'text-text-muted hover:text-text',
            )}
          >
            <Icon name={THEME_ICONS[opt.value]} size={14} />
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

function Section({
  label,
  children,
  variants,
}: {
  label: string
  children: ReactNode
  // Passed by the page for the web-only staggered reveal; omitted (undefined) on
  // mobile / reduced-motion so the section renders statically.
  variants?: Variants
}) {
  return (
    <motion.section className="flex flex-col gap-3" variants={variants}>
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
        {label}
      </h3>
      {children}
    </motion.section>
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
