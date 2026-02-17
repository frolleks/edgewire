import { eq } from "drizzle-orm";
import { db } from "../db";
import { users } from "../db/schema";
import { resolveAvatarUrl } from "../storage/s3";

const USERNAME_PATTERN = /[^a-zA-Z0-9_]/g;

export interface AuthUserLike {
  id: string;
  email?: string | null;
  name?: string | null;
  image?: string | null;
}

export interface UserSummary {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
}

const normalizeUsername = (value: string): string => {
  const normalized = value.replace(USERNAME_PATTERN, "").toLowerCase();
  return normalized.length >= 3 ? normalized.slice(0, 32) : `user${normalized}`.slice(0, 32);
};

const baseUsername = (user: AuthUserLike): string => {
  const fromEmail = user.email?.split("@")[0];
  const fromName = user.name?.trim().replace(/\s+/g, "_");
  return normalizeUsername(fromName || fromEmail || "user");
};

const randomSuffix = () => Math.floor(Math.random() * 10_000).toString().padStart(4, "0");

type UserRowLike = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  avatarS3Key: string | null;
};

export const toUserSummary = (row: UserRowLike): UserSummary => ({
  id: row.id,
  username: row.username,
  display_name: row.displayName,
  avatar_url: resolveAvatarUrl(row.avatarS3Key, row.avatarUrl),
});

export const getUserSummaryById = async (userId: string): Promise<UserSummary | null> => {
  const row = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });

  return row ? toUserSummary(row) : null;
};

export const ensureAppUser = async (authUser: AuthUserLike): Promise<UserSummary> => {
  const existing = await db.query.users.findFirst({
    where: eq(users.id, authUser.id),
  });
  if (existing) {
    return toUserSummary(existing);
  }

  const displayName = (authUser.name || authUser.email?.split("@")[0] || "User").slice(0, 64);
  const base = baseUsername(authUser);

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const username = attempt === 0 ? base : `${base.slice(0, 27)}_${randomSuffix()}`;

    try {
      const [created] = await db
        .insert(users)
        .values({
          id: authUser.id,
          username,
          displayName,
          avatarUrl: authUser.image ?? null,
          avatarS3Key: null,
        })
        .returning();

      if (created) {
        return toUserSummary(created);
      }
    } catch (error) {
      const message = String(error);
      if (message.includes("users_pkey")) {
        const raceWinner = await db.query.users.findFirst({ where: eq(users.id, authUser.id) });
        if (raceWinner) {
          return toUserSummary(raceWinner);
        }
      }

      if (!message.includes("users_username_unique")) {
        throw error;
      }
    }
  }

  throw new Error("Unable to allocate a unique username.");
};
