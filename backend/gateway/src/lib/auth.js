// Better Auth instance — the gateway's auth authority.
//
// Cookie-based sessions (httpOnly), email/password + Google. Configured to fit
// the existing domain schema:
//   - numeric autoincrement IDs (the whole schema uses Int) via generateId:'serial'
//   - the auth-session model is renamed to `AuthSession` so it does NOT collide
//     with the domain `Session` table (dining sessions)
//   - core user fields map onto existing columns (name->display_name, image->avatar_url)
//   - `role` is a read-only mirror; authorization stays Prisma/gateway-owned
//   - username plugin (we rely on User.username @unique); since it isn't required
//     at signup, a create-hook derives a unique username from the email
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { username } from 'better-auth/plugins';
import { prisma } from './prisma.js';
import { config } from '../config/index.js';

/**
 * Derive a unique, valid username from an email, appending a numeric suffix on
 * collision (User.username is NOT NULL + unique). Runs for password AND social
 * signups (Google users have no username otherwise).
 * @param {string} email
 * @returns {Promise<string>}
 */
const uniqueUsernameFromEmail = async (email) => {
  const base = (email?.split('@')[0] || 'user').toLowerCase().replace(/[^a-z0-9_]/g, '') || 'user';
  let candidate = base;
  let n = 1;
  while (await prisma.user.findUnique({ where: { username: candidate } })) {
    candidate = `${base}${n++}`;
  }
  return candidate;
};

const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  secret: config.BETTER_AUTH_SECRET,
  baseURL: config.BETTER_AUTH_URL,
  trustedOrigins: [config.CORS_ORIGIN],

  emailAndPassword: { enabled: true },
  socialProviders: {
    google: {
      clientId: config.GOOGLE_CLIENT_ID,
      clientSecret: config.GOOGLE_CLIENT_SECRET,
    },
  },

  account: {
    accountLinking: {
      enabled: true,
      // Auto-link Google to an existing same-email account (incl. accounts that
      // already have a password). Safe because Google verifies email ownership.
      trustedProviders: ['google'],
      // Don't require the EXISTING local account's email to be verified before
      // linking. Our email/password signups never set emailVerified, so without
      // this Better Auth returns `account_not_linked`. The Google side still
      // proves ownership of the address (that's what trustedProviders is for).
      requireLocalEmailVerified: false,
    },
  },

  advanced: {
    // The whole domain schema uses Int autoincrement PKs; let Postgres generate them.
    database: { generateId: 'serial' },

    // Cross-site cookies (prod only, gated by CROSS_SITE_COOKIES). When the
    // frontend and gateway are on DIFFERENT domains (Render ↔ Fly), the browser
    // only sends the httpOnly session cookie cross-site if it's SameSite=None;
    // Secure. Off locally so http dev keeps first-party Lax via the Vite proxy
    // (Secure cookies are rejected over http). NOT crossSubDomainCookies — that
    // needs a shared parent domain, which onrender.com ↔ fly.dev don't share.
    //
    // NOT `partitioned` (CHIPS): a partitioned cookie is keyed to the top-level
    // site that set it, so the OAuth `state` cookie (set on the onrender.com
    // frontend) is invisible when Google redirects to the fly.dev gateway
    // callback — causing `state_mismatch`. Plain SameSite=None survives the
    // cross-site redirect.
    ...(config.crossSiteCookies && {
      useSecureCookies: true,
      defaultCookieAttributes: { sameSite: 'none', secure: true },
    }),
  },

  user: {
    // Map Better Auth's core fields onto the existing snake_case columns.
    fields: {
      name: 'display_name',
      image: 'avatar_url',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
    // Expose `role` as a read-only mirror — the DB default (USER) fills it on
    // insert; we never let clients set it. Authorization stays gateway-owned.
    additionalFields: {
      role: { type: 'string', input: false, required: false },
    },
  },

  // Rename the auth-session model so it never clobbers the domain `Session`.
  session: { modelName: 'AuthSession' },

  plugins: [username()],

  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          // Fill the NOT-NULL unique username the domain schema requires.
          if (!user.username) {
            return { data: { ...user, username: await uniqueUsernameFromEmail(user.email) } };
          }
          return { data: user };
        },
      },
    },
  },
});

export { auth };
