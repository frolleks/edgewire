import type { AppRoute } from "@/app/types";

export type { AppRoute } from "@/app/types";

export const parseRoute = (pathname: string): AppRoute => {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "app") {
    return { mode: "dm", guildId: null, channelId: null };
  }

  if (parts[1] !== "channels") {
    return { mode: "dm", guildId: null, channelId: null };
  }

  if (parts[2] === "@me") {
    return {
      mode: "dm",
      guildId: null,
      channelId: parts[3] ?? null,
    };
  }

  if (parts[2]) {
    return {
      mode: "guild",
      guildId: parts[2],
      channelId: parts[3] ?? null,
    };
  }

  return { mode: "dm", guildId: null, channelId: null };
};
