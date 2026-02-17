import type { UserSummary } from "@discord/types";

export type SessionUser = {
  id: string;
  email?: string;
  name?: string;
  image?: string | null;
};

export type AppRoute = {
  mode: "dm" | "guild";
  guildId: string | null;
  channelId: string | null;
};

export type ProfileDialogState = {
  user: UserSummary;
  guildId: string | null;
};

export type ComposerAttachment = {
  local_id: string;
  file: File | null;
  filename: string;
  size: number;
  content_type: string;
  status: "queued" | "uploading" | "uploaded" | "failed";
  upload_id?: string;
  error?: string;
};
