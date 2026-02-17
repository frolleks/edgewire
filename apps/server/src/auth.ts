import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { env } from "./env";
import { db } from "./db";
import {
  authAccounts,
  authSessions,
  authUsers,
  authVerifications,
} from "./db/auth-schema";
import { ensureAppUser } from "./lib/users";

const betterAuthDrizzleSchema = {
  auth_users: authUsers,
  auth_sessions: authSessions,
  auth_accounts: authAccounts,
  auth_verifications: authVerifications,
} as const;

export const auth = betterAuth({
  secret: env.BETTER_AUTH_SECRET,
  baseURL: "http://localhost:3001",
  basePath: "/api/auth",
  trustedOrigins: [env.APP_ORIGIN],
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
    autoSignIn: true,
  },
  advanced: {
    useSecureCookies: env.COOKIE_SECURE,
  },
  user: {
    modelName: "auth_users",
    changeEmail: {
      enabled: true,
      updateEmailWithoutVerification: true,
    },
  },
  session: {
    modelName: "auth_sessions",
  },
  account: {
    modelName: "auth_accounts",
  },
  verification: {
    modelName: "auth_verifications",
  },
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: betterAuthDrizzleSchema,
  }),
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          await ensureAppUser({
            id: String(user.id),
            name: String(user.name),
            email: String(user.email),
            image: user.image ? String(user.image) : null,
          });
        },
      },
    },
  },
});
