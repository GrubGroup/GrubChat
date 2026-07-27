import { useState } from 'react'
import { useNavigate, useOutletContext } from 'react-router'
import { Button, Input } from '@/components/ui'
import { useGroupsStore, mostRecentGroup } from '@/stores/groupsStore'
import { toSlugId } from '@/utils/slug'
import { useAuthStore } from '@/stores/authStore'
import { signIn, signUp } from '@/lib/authClient'
import { fetchProfile } from '@/api/profileApi'
import { fetchAuthMethods } from '@/api/authApi'
import type { AuthFlowContext } from '@/components/layout/AuthFlowShell'
import type { SessionUser } from '@/stores/authStore'

export interface AuthFormProps {
  mode: 'signin' | 'signup'
}

const GoogleMark = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#4285F4" d="M22.5 12.2c0-.7-.1-1.4-.2-2H12v3.9h5.9a5 5 0 0 1-2.2 3.3v2.7h3.6c2.1-2 3.2-4.9 3.2-7.9Z" />
    <path fill="#34A853" d="M12 23c2.9 0 5.4-1 7.2-2.6l-3.6-2.7c-1 .7-2.3 1.1-3.6 1.1-2.8 0-5.1-1.9-6-4.4H2.3v2.8A11 11 0 0 0 12 23Z" />
    <path fill="#FBBC05" d="M6 14.3a6.6 6.6 0 0 1 0-4.2V7.3H2.3a11 11 0 0 0 0 9.9L6 14.3Z" />
    <path fill="#EA4335" d="M12 5.5c1.6 0 3 .5 4.1 1.6l3.1-3.1A11 11 0 0 0 2.3 7.3L6 10.1c.9-2.6 3.2-4.6 6-4.6Z" />
  </svg>
)

// Sign-in / sign-up form content. Rendered inside AuthFlowShell, which owns the
// persistent brand panel and the slide transition into onboarding — this is just
// the right-panel form.
export function AuthForm({ mode }: AuthFormProps) {
  const navigate = useNavigate()
  // The shell owns the full-screen branded splash shown while the post-auth forward
  // (profile + groups fetch) runs. NOT used on the new-account path — that stays in
  // the shell and slides to onboarding.
  const { setForwarding } = useOutletContext<AuthFlowContext>()
  const loadGroups = useGroupsStore((s) => s.load)
  const setSessionUser = useAuthStore((s) => s.setSessionUser)
  const setEntryFlowActive = useAuthStore((s) => s.setEntryFlowActive)
  const isSignup = mode === 'signup'

  const [fullName, setFullName] = useState('')
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  // Sign-in accepts a username OR an email in one field.
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  // Set when the entered email belongs to a Google-only account — we stop the
  // password attempt and emphasize the Google button instead.
  const [googleHint, setGoogleHint] = useState(false)

  // After a successful email/password auth, route per mode. The session cookie
  // is already set; App's useSession picks up the user. (Google redirects away
  // and returns to the app, so it doesn't reach here.)
  //
  // First gate on onboarding: no saved profile (brand-new signup, or a returning
  // user who abandoned onboarding) → /onboarding. That stays inside the shell, so
  // the right panel SLIDES into onboarding (no splash). Otherwise forward into the
  // app — an existing user with groups lands in their most recent group chat; one
  // with none sees /groups — showing the splash meanwhile.
  const onAuthed = async () => {
    // A brand-new account can't have a saved profile — go straight to onboarding
    // so the right panel SLIDES in immediately (no profile fetch stalling the
    // transition, and no splash). The persistent BrandPanel (left) doesn't remount.
    if (isSignup) {
      navigate('/onboarding')
      return
    }
    // Returning user: gate on whether they finished onboarding before. If they
    // abandoned it (no profile), slide into onboarding inside the shell; otherwise
    // forward into the app behind the branded splash.
    const profile = await fetchProfile()
    if (!profile) {
      navigate('/onboarding')
      return
    }
    setForwarding(true)
    await loadGroups()
    const latest = mostRecentGroup(useGroupsStore.getState().groups)
    navigate(latest ? `/groups/${toSlugId(latest.name, latest.id)}` : '/groups')
  }

  const handleSubmit = async () => {
    setError(null)
    setGoogleHint(false)
    setLoading(true)

    // The email being authenticated (signup uses `email`; signin uses
    // `identifier` only when it looks like an email).
    const emailForCheck = isSignup ? email : identifier.includes('@') ? identifier : ''
    if (emailForCheck) {
      // If this email is a Google-only account, a password attempt would just
      // fail/confuse — send them to "Continue with Google" instead.
      const methods = await fetchAuthMethods(emailForCheck)
      if (methods.google && !methods.password) {
        setLoading(false)
        setGoogleHint(true)
        setError('This email is registered with Google. Use "Continue with Google" above.')
        return
      }
    }

    let authError
    let authData
    if (isSignup) {
      if (!email || !password || !username) {
        setError('Username, email, and password are required.')
        setLoading(false)
        return
      }
      // Better Auth client methods resolve with { data, error } (no throw).
      ;({ data: authData, error: authError } = await signUp.email({
        email,
        password,
        name: fullName,
        username,
      }))
    } else {
      if (!identifier || !password) {
        setError('Enter your username or email and password.')
        setLoading(false)
        return
      }
      // Detect which credential the user typed: an "@" means it's an email.
      ;({ data: authData, error: authError } = identifier.includes('@')
        ? await signIn.email({ email: identifier, password })
        : await signIn.username({ username: identifier, password }))
    }

    if (authError) {
      setLoading(false)
      setError(authError.message ?? 'Something went wrong. Please try again.')
      return
    }

    // Claim the entry flow BEFORE syncing the session: this stops App from
    // running its own post-auth forward + branded splash when useSession picks up
    // the new session — that splash would unmount AuthFlowShell and kill the
    // slide from sign-up into onboarding. This form now owns the routing.
    setEntryFlowActive(true)

    // Sync the auth store from the sign-in response *now*, before navigating.
    // App's useSession effect only mirrors the session on its next refetch, so
    // without this the auth guard would briefly see user===null on the
    // destination screen and bounce back to the sign-in form (a visible flash).
    const authedUser = (authData as { user?: SessionUser } | null)?.user
    if (authedUser) setSessionUser(authedUser)

    // Keep the button in its loading state through the forward: on success this
    // component either slides out to onboarding or is replaced by the splash, so
    // we never reset `loading` (avoids a flash of the idle button mid-forward).
    await onAuthed()
  }

  // Google: full server-side OAuth redirect. On return, App routes based on the
  // now-active session; callbackURL brings the browser back to the app.
  const handleGoogle = async () => {
    setError(null)
    const { error: authError } = await signIn.social({
      provider: 'google',
      callbackURL: window.location.origin,
    })
    if (authError) setError('Google sign-in failed. Please try again.')
  }

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-5">
      <div>
        <h1 className="font-display text-3xl font-bold text-text">
          {isSignup ? 'Create your account' : 'Welcome back'}
        </h1>
        <p className="mt-1 text-sm text-text-muted">
          {isSignup
            ? 'Set your preferences once. Never repeat yourself.'
            : 'Sign in to your account to continue'}
        </p>
      </div>

      <div className="flex flex-col gap-2.5">
        <button
          type="button"
          onClick={handleGoogle}
          disabled={loading}
          className={`flex h-11 w-full items-center justify-center gap-2 rounded-input border bg-surface-raised text-sm font-medium text-text hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-50 ${
            googleHint ? 'border-text ring-2 ring-focus-ring' : 'border-border'
          }`}
        >
          <GoogleMark /> Continue with Google
        </button>
      </div>

      <div className="flex items-center gap-3 text-xs text-text-muted">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>

      <div className="flex flex-col gap-3">
        {isSignup ? (
          <>
            <Input
              label="FULL NAME"
              placeholder="Dev Patel"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
            />
            <Input
              label="USERNAME"
              placeholder="devpatel"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              hint="3–30 characters: letters, numbers, dots, underscores."
            />
            <Input
              label="EMAIL"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </>
        ) : (
          <Input
            label="USERNAME OR EMAIL"
            placeholder="devpatel or you@example.com"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
          />
        )}
        <div className="flex flex-col gap-1.5">
          {!isSignup && (
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-text">PASSWORD</span>
              <button type="button" className="text-xs text-text-muted hover:text-text">
                Forgot password?
              </button>
            </div>
          )}
          <Input
            label={isSignup ? 'PASSWORD' : undefined}
            type="password"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSubmit()
            }}
          />
        </div>
      </div>

      {error && <p className="text-sm text-error">{error}</p>}

      <Button fullWidth variant="primary" onClick={handleSubmit} isLoading={loading}>
        {isSignup ? 'Create account' : 'Sign in'}
      </Button>

      {isSignup && (
        <p className="text-center text-xs text-text-muted">
          By signing up you agree to our Terms and Privacy Policy.
        </p>
      )}

      <p className="text-center text-sm text-text-muted">
        {isSignup ? 'Already have an account? ' : "Don't have an account? "}
        <button
          onClick={() => navigate(isSignup ? '/login' : '/signup')}
          className="font-semibold text-text hover:text-primary"
        >
          {isSignup ? 'Sign in' : 'Sign up'}
        </button>
      </p>
    </div>
  )
}
