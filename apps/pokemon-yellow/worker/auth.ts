import { betterAuth } from 'better-auth';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from './authSchema';
import { isLocal, type Context, type Env } from './env';
import { queueMail } from './mail';

export function createAuth(request: Request, env: Env, ctx: Context) {
  const local = isLocal(request, env);
  const origin = new URL(env.APP_ORIGIN);
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32 || (!local && env.BETTER_AUTH_SECRET.startsWith('local-development-only')) ||
      (!local && (origin.protocol !== 'https:' || !env.EMAIL_FROM || !env.POSTMARK_SERVER_TOKEN || env.POSTMARK_SERVER_TOKEN === 'POSTMARK_API_TEST' || env.LOCAL_DEV === 'true'))) {
    throw new Error('Authentication is not configured. See DEPLOYMENT.md.');
  }
  return betterAuth({
    appName: 'Pokémon Yellow Web', baseURL: env.APP_ORIGIN, basePath: '/api/auth',
    secret: env.BETTER_AUTH_SECRET, trustedOrigins: [env.APP_ORIGIN],
    database: drizzleAdapter(drizzle(env.DB), { provider: 'sqlite', schema, transaction: false }),
    emailAndPassword: {
      enabled: true, requireEmailVerification: true, autoSignIn: false,
      minPasswordLength: 12, maxPasswordLength: 128, revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => { queueMail(request, env, ctx, user.email, 'Reset your Pokémon Yellow password', url); },
    },
    emailVerification: {
      sendOnSignUp: true, sendOnSignIn: true, autoSignInAfterVerification: false, expiresIn: 3600,
      sendVerificationEmail: async ({ user, url }) => { queueMail(request, env, ctx, user.email, 'Verify your Pokémon Yellow account', url); },
    },
    session: { expiresIn: 7 * 24 * 60 * 60, updateAge: 24 * 60 * 60, cookieCache: { enabled: false } },
    rateLimit: {
      enabled: true, storage: 'database', window: 60, max: local ? 300 : 60,
      customRules: local ? {
        '/sign-in/email': { window: 60, max: 300 }, '/sign-up/email': { window: 60, max: 300 },
        '/request-password-reset': { window: 60, max: 300 }, '/reset-password': { window: 60, max: 300 },
      } : undefined,
    },
    advanced: { cookiePrefix: 'pokemon-yellow', useSecureCookies: !local, ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] } },
    telemetry: { enabled: false },
  });
}
