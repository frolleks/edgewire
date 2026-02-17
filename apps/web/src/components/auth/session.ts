import type { SessionUser } from "@/app/types";

export type { SessionUser } from "@/app/types";

export const getSessionUser = (data: unknown): SessionUser | null => {
  if (!data || typeof data !== "object" || !("user" in data)) {
    return null;
  }

  const user = (data as { user?: SessionUser }).user;
  return user?.id ? user : null;
};
