import { eq } from "drizzle-orm";
import { db } from "../db";
import { authUsers } from "../db/auth-schema";
import { userProfiles, userSettings, users } from "../db/schema";
import { resolveAvatarUrl } from "../storage/s3";

const USERNAME_CLEAN_PATTERN = /[^a-z0-9_.]/g;
const MIN_USERNAME_LENGTH = 2;
const MAX_USERNAME_LENGTH = 32;
const MAX_DISPLAY_NAME_LENGTH = 32;

export const USERNAME_REGEX = /^[a-z0-9_.]{2,32}$/;

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

export type UserTheme = "system" | "light" | "dark";
export type NotificationLevel = "ALL_MESSAGES" | "ONLY_MENTIONS" | "NOTHING";
export type PresencePreference = "online" | "idle" | "dnd" | "invisible";

export interface UserSettingsPayload {
  theme: UserTheme;
  compact_mode: boolean;
  show_timestamps: boolean;
  locale: string | null;
  enable_desktop_notifications: boolean;
  notification_sounds: boolean;
  presence_status: PresencePreference;
  show_current_activity: boolean;
  default_guild_notification_level: NotificationLevel;
}

export interface CurrentUserPayload extends UserSummary {
  banner_url: string | null;
  bio: string | null;
  pronouns: string | null;
  status: string | null;
  email: string | null;
  settings: UserSettingsPayload;
}

const DEFAULT_SETTINGS: UserSettingsPayload = {
  theme: "system",
  compact_mode: false,
  show_timestamps: true,
  locale: null,
  enable_desktop_notifications: false,
  notification_sounds: true,
  presence_status: "online",
  show_current_activity: false,
  default_guild_notification_level: "ONLY_MENTIONS",
};

const randomSuffix = (): string => Math.floor(Math.random() * 10_000).toString().padStart(4, "0");

const normalizeUsernameCandidate = (value: string): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(USERNAME_CLEAN_PATTERN, "")
    .replace(/[._]{2,}/g, "_")
    .replace(/^[_\.]+|[_\.]+$/g, "");

  if (!normalized) {
    return "user";
  }

  return normalized.slice(0, MAX_USERNAME_LENGTH);
};

const withMinUsernameLength = (value: string): string => {
  if (value.length >= MIN_USERNAME_LENGTH) {
    return value.slice(0, MAX_USERNAME_LENGTH);
  }

  return `${value}user`.slice(0, MAX_USERNAME_LENGTH);
};

const normalizeGeneratedUsername = (value: string): string =>
  withMinUsernameLength(normalizeUsernameCandidate(value));

export const normalizeUsernameForUpdate = (value: string): string => value.trim().toLowerCase();

export const isValidUsername = (value: string): boolean => USERNAME_REGEX.test(value);

const baseUsername = (user: AuthUserLike): string => {
  const fromEmail = user.email?.split("@")[0] ?? "";
  const fromName = user.name?.trim() ?? "";
  return normalizeGeneratedUsername(fromName || fromEmail || "user");
};

const defaultDisplayName = (user: AuthUserLike): string => {
  const fromName = user.name?.trim();
  const fromEmail = user.email?.split("@")[0]?.trim();
  const value = fromName || fromEmail || "User";
  return value.slice(0, MAX_DISPLAY_NAME_LENGTH);
};

type UserRowLike = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  avatarS3Key: string | null;
};

type SummarySource = {
  id: string;
  userUsername: string;
  userDisplayName: string;
  userAvatarUrl: string | null;
  userAvatarS3Key: string | null;
  profileUsername: string | null;
  profileDisplayName: string | null;
  profileAvatarUrl: string | null;
  authName: string | null;
  authImage: string | null;
};

export const toUserSummary = (row: UserRowLike): UserSummary => ({
  id: row.id,
  username: row.username,
  display_name: row.displayName,
  avatar_url: resolveAvatarUrl(row.avatarS3Key, row.avatarUrl),
});

const toSummaryFromSource = (source: SummarySource): UserSummary => {
  const username = source.profileUsername ?? source.userUsername;
  const displayName =
    source.profileDisplayName?.trim() ||
    source.userDisplayName?.trim() ||
    source.authName?.trim() ||
    username;
  const avatarInput = source.profileAvatarUrl ?? source.userAvatarUrl ?? source.authImage ?? null;

  return {
    id: source.id,
    username,
    display_name: displayName,
    avatar_url: resolveAvatarUrl(source.userAvatarS3Key, avatarInput),
  };
};

const ensureSupplementaryRows = async (
  authUser: AuthUserLike,
  legacyUser: {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
  },
): Promise<void> => {
  await db
    .insert(userProfiles)
    .values({
      userId: authUser.id,
      username: legacyUser.username,
      displayName: legacyUser.displayName || defaultDisplayName(authUser),
      avatarUrl: legacyUser.avatarUrl ?? authUser.image ?? null,
      bannerUrl: null,
      bio: null,
      pronouns: null,
      status: null,
    })
    .onConflictDoNothing({ target: userProfiles.userId });

  await db
    .insert(userSettings)
    .values({
      userId: authUser.id,
    })
    .onConflictDoNothing({ target: userSettings.userId });
};

const buildMergedUserPayload = (row: {
  id: string;
  userUsername: string;
  userDisplayName: string;
  userAvatarUrl: string | null;
  userAvatarS3Key: string | null;
  profileUsername: string | null;
  profileDisplayName: string | null;
  profileAvatarUrl: string | null;
  profileBannerUrl: string | null;
  profileBio: string | null;
  profilePronouns: string | null;
  profileStatus: string | null;
  authName: string | null;
  authEmail: string | null;
  authImage: string | null;
  settingsTheme: UserTheme | null;
  settingsCompactMode: boolean | null;
  settingsShowTimestamps: boolean | null;
  settingsLocale: string | null;
  settingsEnableDesktopNotifications: boolean | null;
  settingsNotificationSounds: boolean | null;
  settingsPresenceStatus: PresencePreference | null;
  settingsShowCurrentActivity: boolean | null;
  settingsDefaultGuildNotificationLevel: NotificationLevel | null;
}): CurrentUserPayload => {
  const summary = toSummaryFromSource({
    id: row.id,
    userUsername: row.userUsername,
    userDisplayName: row.userDisplayName,
    userAvatarUrl: row.userAvatarUrl,
    userAvatarS3Key: row.userAvatarS3Key,
    profileUsername: row.profileUsername,
    profileDisplayName: row.profileDisplayName,
    profileAvatarUrl: row.profileAvatarUrl,
    authName: row.authName,
    authImage: row.authImage,
  });

  return {
    ...summary,
    banner_url: row.profileBannerUrl,
    bio: row.profileBio,
    pronouns: row.profilePronouns,
    status: row.profileStatus,
    email: row.authEmail,
    settings: {
      theme: row.settingsTheme ?? DEFAULT_SETTINGS.theme,
      compact_mode: row.settingsCompactMode ?? DEFAULT_SETTINGS.compact_mode,
      show_timestamps: row.settingsShowTimestamps ?? DEFAULT_SETTINGS.show_timestamps,
      locale: row.settingsLocale ?? DEFAULT_SETTINGS.locale,
      enable_desktop_notifications:
        row.settingsEnableDesktopNotifications ?? DEFAULT_SETTINGS.enable_desktop_notifications,
      notification_sounds: row.settingsNotificationSounds ?? DEFAULT_SETTINGS.notification_sounds,
      presence_status: row.settingsPresenceStatus ?? DEFAULT_SETTINGS.presence_status,
      show_current_activity: row.settingsShowCurrentActivity ?? DEFAULT_SETTINGS.show_current_activity,
      default_guild_notification_level:
        row.settingsDefaultGuildNotificationLevel ?? DEFAULT_SETTINGS.default_guild_notification_level,
    },
  };
};

export const getUserSummaryById = async (userId: string): Promise<UserSummary | null> => {
  const [row] = await db
    .select({
      id: users.id,
      userUsername: users.username,
      userDisplayName: users.displayName,
      userAvatarUrl: users.avatarUrl,
      userAvatarS3Key: users.avatarS3Key,
      profileUsername: userProfiles.username,
      profileDisplayName: userProfiles.displayName,
      profileAvatarUrl: userProfiles.avatarUrl,
      authName: authUsers.name,
      authImage: authUsers.image,
    })
    .from(users)
    .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
    .leftJoin(authUsers, eq(authUsers.id, users.id))
    .where(eq(users.id, userId))
    .limit(1);

  if (!row) {
    return null;
  }

  return toSummaryFromSource(row);
};

export const getCurrentUserById = async (userId: string): Promise<CurrentUserPayload | null> => {
  const [row] = await db
    .select({
      id: users.id,
      userUsername: users.username,
      userDisplayName: users.displayName,
      userAvatarUrl: users.avatarUrl,
      userAvatarS3Key: users.avatarS3Key,
      profileUsername: userProfiles.username,
      profileDisplayName: userProfiles.displayName,
      profileAvatarUrl: userProfiles.avatarUrl,
      profileBannerUrl: userProfiles.bannerUrl,
      profileBio: userProfiles.bio,
      profilePronouns: userProfiles.pronouns,
      profileStatus: userProfiles.status,
      authName: authUsers.name,
      authEmail: authUsers.email,
      authImage: authUsers.image,
      settingsTheme: userSettings.theme,
      settingsCompactMode: userSettings.compactMode,
      settingsShowTimestamps: userSettings.showTimestamps,
      settingsLocale: userSettings.locale,
      settingsEnableDesktopNotifications: userSettings.enableDesktopNotifications,
      settingsNotificationSounds: userSettings.notificationSounds,
      settingsPresenceStatus: userSettings.presenceStatus,
      settingsShowCurrentActivity: userSettings.showCurrentActivity,
      settingsDefaultGuildNotificationLevel: userSettings.defaultGuildNotificationLevel,
    })
    .from(users)
    .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
    .leftJoin(authUsers, eq(authUsers.id, users.id))
    .leftJoin(userSettings, eq(userSettings.userId, users.id))
    .where(eq(users.id, userId))
    .limit(1);

  if (!row) {
    return null;
  }

  return buildMergedUserPayload(row);
};

export const ensureAppUser = async (authUser: AuthUserLike): Promise<UserSummary> => {
  const existing = await db.query.users.findFirst({
    where: eq(users.id, authUser.id),
  });

  if (existing) {
    await ensureSupplementaryRows(authUser, existing);
    const merged = await getUserSummaryById(authUser.id);
    return merged ?? toUserSummary(existing);
  }

  const displayName = defaultDisplayName(authUser);
  const avatarUrl = authUser.image ?? null;
  const base = baseUsername(authUser);

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const username = attempt === 0 ? base : `${base.slice(0, 27)}_${randomSuffix()}`;

    try {
      await db.transaction(async tx => {
        await tx.insert(users).values({
          id: authUser.id,
          username,
          displayName,
          avatarUrl,
          avatarS3Key: null,
        });

        await tx.insert(userProfiles).values({
          userId: authUser.id,
          username,
          displayName,
          avatarUrl,
          bannerUrl: null,
          bio: null,
          pronouns: null,
          status: null,
        });

        await tx.insert(userSettings).values({
          userId: authUser.id,
        });
      });

      const created = await getUserSummaryById(authUser.id);
      if (created) {
        return created;
      }
    } catch (error) {
      const message = String(error);

      if (message.includes("users_pkey")) {
        const raceWinner = await db.query.users.findFirst({ where: eq(users.id, authUser.id) });
        if (raceWinner) {
          await ensureSupplementaryRows(authUser, raceWinner);
          const merged = await getUserSummaryById(authUser.id);
          return merged ?? toUserSummary(raceWinner);
        }
      }

      const usernameConflict =
        message.includes("users_username_unique") || message.includes("user_profiles_username_unique");

      if (!usernameConflict) {
        throw error;
      }
    }
  }

  throw new Error("Unable to allocate a unique username.");
};
