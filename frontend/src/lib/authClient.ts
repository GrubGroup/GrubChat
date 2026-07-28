import { createAuthClient } from 'better-auth/react'
import { usernameClient } from 'better-auth/client/plugins'
import { GATEWAY_URL } from './env'

// Better Auth client. Talks to the gateway's /api/auth/* endpoints; the session
// lives in an httpOnly cookie (credentials included), so there's no token to
// store or decode client-side.
export const authClient = createAuthClient({
  // Empty GATEWAY_URL → same-origin (dev goes through the Vite proxy so the
  // session cookie is first-party). Falls back to the current origin.
  baseURL: GATEWAY_URL || undefined,
  plugins: [usernameClient()],
})

export const { signIn, signUp, signOut, useSession, changeEmail, changePassword, linkSocial } =
  authClient
