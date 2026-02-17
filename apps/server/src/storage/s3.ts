import { S3Client, s3 } from "bun";
import { env } from "../env";

export type StorageObjectKind = "avatars" | "attachments";

export type S3Acl =
  | "public-read"
  | "private"
  | "public-read-write"
  | "authenticated-read"
  | "aws-exec-read"
  | "bucket-owner-read"
  | "bucket-owner-full-control"
  | "log-delivery-write";

type MakeObjectKeyParams = {
  kind: StorageObjectKind;
  userId: string;
  channelId?: string;
  messageId?: string;
  filename: string;
};

const FALLBACK_S3 = s3;

const normalizeFilename = (filename: string): string => {
  const value = filename.replace(/\\+/g, "/").split("/").pop() ?? "file";
  return value.trim() || "file";
};

const sanitizeBasename = (value: string): string => {
  const basename = value.replace(/\.[^/.]+$/, "");
  const safe = (basename ?? "file")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
  return safe || "file";
};

const safeExtension = (filename: string): string => {
  const normalized = normalizeFilename(filename);
  const match = normalized.toLowerCase().match(/\.([a-z0-9]{1,10})$/);
  return match?.[1] ?? "bin";
};

const sanitizeFilename = (filename: string): string => {
  const normalized = normalizeFilename(filename);
  const ext = safeExtension(normalized);
  const basename = sanitizeBasename(normalized);
  return `${basename}.${ext}`;
};

const randomKeySuffix = (): string => crypto.randomUUID().replace(/-/g, "");

const encodeObjectPath = (key: string): string =>
  key
    .split("/")
    .filter(Boolean)
    .map(segment => encodeURIComponent(segment))
    .join("/");

const buildClient = (): S3Client => {
  const options: {
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
    bucket?: string;
    region?: string;
    endpoint?: string;
    virtualHostedStyle?: boolean;
  } = {};

  if (env.S3_ACCESS_KEY_ID) {
    options.accessKeyId = env.S3_ACCESS_KEY_ID;
  }

  if (env.S3_SECRET_ACCESS_KEY) {
    options.secretAccessKey = env.S3_SECRET_ACCESS_KEY;
  }

  if (env.S3_SESSION_TOKEN) {
    options.sessionToken = env.S3_SESSION_TOKEN;
  }

  if (env.S3_BUCKET) {
    options.bucket = env.S3_BUCKET;
  }

  if (env.S3_REGION) {
    options.region = env.S3_REGION;
  }

  if (env.S3_ENDPOINT) {
    options.endpoint = env.S3_ENDPOINT;
  }

  if (env.S3_VIRTUAL_HOSTED_STYLE !== undefined) {
    options.virtualHostedStyle = env.S3_VIRTUAL_HOSTED_STYLE;
  }

  return new S3Client(options);
};

export const s3Client = buildClient();

export const avatarsArePublic = Boolean(env.FILES_PUBLIC_BASE_URL);

export const toPublicObjectUrl = (key: string): string | null => {
  if (!env.FILES_PUBLIC_BASE_URL) {
    return null;
  }
  return `${env.FILES_PUBLIC_BASE_URL}/${encodeObjectPath(key)}`;
};

export const resolveAvatarUrl = (avatarS3Key: string | null | undefined, avatarUrl: string | null): string | null => {
  if (!avatarS3Key) {
    return avatarUrl;
  }

  const publicUrl = toPublicObjectUrl(avatarS3Key);
  if (publicUrl) {
    return publicUrl;
  }

  return presignGet(avatarS3Key, {
    expiresIn: env.DOWNLOAD_PRESIGN_EXPIRES_SECONDS,
  });
};

export const makeObjectKey = ({ kind, userId, channelId, filename }: MakeObjectKeyParams): string => {
  const random = randomKeySuffix();
  const ext = safeExtension(filename);

  if (kind === "avatars") {
    return `avatars/${userId}/${random}.${ext}`;
  }

  const safeName = sanitizeFilename(filename);
  const date = new Date();
  const year = date.getUTCFullYear().toString();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const channel = channelId ?? userId;
  return `attachments/${channel}/${year}/${month}/${random}-${safeName}`;
};

export const presignPut = (
  key: string,
  options: {
    contentType: string;
    acl?: S3Acl;
    expiresIn?: number;
  },
): string =>
  s3Client.presign(key, {
    method: "PUT",
    type: options.contentType,
    expiresIn: options.expiresIn ?? env.UPLOAD_PRESIGN_EXPIRES_SECONDS,
    acl: options.acl,
  });

export const presignGet = (
  key: string,
  options?: {
    expiresIn?: number;
    contentDisposition?: string;
    contentType?: string;
  },
): string =>
  s3Client.presign(key, {
    method: "GET",
    expiresIn: options?.expiresIn ?? env.DOWNLOAD_PRESIGN_EXPIRES_SECONDS,
    contentDisposition: options?.contentDisposition,
    type: options?.contentType,
  });

export const statObject = async (key: string): Promise<Awaited<ReturnType<S3Client["stat"]>>> =>
  s3Client.stat(key);

export const deleteObject = async (key: string): Promise<void> => {
  await s3Client.delete(key);
};

export const defaultS3 = FALLBACK_S3;
