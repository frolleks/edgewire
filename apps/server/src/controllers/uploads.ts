import { ChannelType } from "@edgewire/types";
import type { BunRequest } from "bun";
import { and, eq, isNull, lt } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { uploadSessions, userProfiles, users } from "../db/schema";
import { env } from "../env";
import { badRequest, empty, forbidden, json, notFound, parseJson, requireAuth } from "../http";
import { PermissionBits } from "../lib/permissions";
import { hasChannelPermission } from "../lib/permission-service";
import { getUserSummaryById, toUserSummary } from "../lib/users";
import { broadcastUserUpdate, canAccessChannel, nextId, toSummary } from "../runtime";
import {
  avatarsArePublic,
  deleteObject,
  makeObjectKey,
  presignPut,
  statObject,
  toPublicObjectUrl,
} from "../storage/s3";

const initiateAvatarUploadSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  content_type: z.string().trim().min(1).max(255),
  size: z.number().int().min(1),
});

const initiateAttachmentUploadSchema = z.object({
  channel_id: z.string().trim().min(1).max(64),
  filename: z.string().trim().min(1).max(255),
  content_type: z.string().trim().min(1).max(255),
  size: z.number().int().min(1),
});

const normalizeMime = (mime: string | null | undefined): string =>
  (mime ?? "")
    .split(";")[0]
    ?.trim()
    .toLowerCase() ?? "";

const mimeMatchesPattern = (mime: string, pattern: string): boolean => {
  if (!mime || !pattern) {
    return false;
  }

  if (pattern.endsWith("/*")) {
    return mime.startsWith(`${pattern.slice(0, -1)}`);
  }

  return mime === pattern;
};

const isMimeAllowed = (mime: string, allowedPatterns: string[]): boolean =>
  allowedPatterns.some(pattern => mimeMatchesPattern(mime, pattern));

const BLOCKED_ATTACHMENT_MIME = new Set([
  "application/x-msdownload",
  "application/x-sh",
  "application/x-bat",
  "application/x-csh",
  "application/x-executable",
]);

const isAttachmentMimeAllowed = (mime: string): boolean =>
  !BLOCKED_ATTACHMENT_MIME.has(mime) && isMimeAllowed(mime, env.UPLOAD_ALLOWED_ATTACHMENT_MIME);

const buildUploadInitResponse = (payload: {
  uploadId: string;
  key: string;
  contentType: string;
  putUrl: string;
  expiresAt: Date;
}) => ({
  upload_id: payload.uploadId,
  key: payload.key,
  method: "PUT" as const,
  put_url: payload.putUrl,
  headers: {
    "Content-Type": payload.contentType,
  },
  expires_at: payload.expiresAt.toISOString(),
});

const bestEffortDeleteObject = async (key: string): Promise<void> => {
  try {
    await deleteObject(key);
  } catch {
    // Best-effort cleanup only.
  }
};

const markSessionExpired = async (uploadId: string): Promise<void> => {
  await db
    .update(uploadSessions)
    .set({
      status: "expired",
      completedAt: new Date(),
    })
    .where(and(eq(uploadSessions.id, uploadId), eq(uploadSessions.status, "pending")));
};

export const initiateAvatarUpload = async (request: Request): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const me = authResult.user;
  const body = await parseJson<unknown>(request);
  const parsed = initiateAvatarUploadSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(request, "Invalid avatar upload payload.");
  }

  const mime = normalizeMime(parsed.data.content_type);
  if (!isMimeAllowed(mime, env.UPLOAD_ALLOWED_AVATAR_MIME)) {
    return badRequest(request, "Avatar content type is not allowed.");
  }

  if (parsed.data.size > env.UPLOAD_MAX_AVATAR_BYTES) {
    return badRequest(request, `Avatar exceeds max upload size (${env.UPLOAD_MAX_AVATAR_BYTES} bytes).`);
  }

  const uploadId = nextId();
  const key = makeObjectKey({
    kind: "avatars",
    userId: me.id,
    filename: parsed.data.filename,
  });
  const expiresAt = new Date(Date.now() + env.UPLOAD_PRESIGN_EXPIRES_SECONDS * 1_000);

  await db.insert(uploadSessions).values({
    id: uploadId,
    userId: me.id,
    kind: "avatar",
    status: "pending",
    s3Key: key,
    filename: parsed.data.filename,
    contentType: mime,
    expectedSize: parsed.data.size,
    channelId: null,
    messageId: null,
    expiresAt,
  });

  const putUrl = presignPut(key, {
    contentType: mime,
    acl: avatarsArePublic ? "public-read" : undefined,
  });

  return json(
    request,
    buildUploadInitResponse({
      uploadId,
      key,
      contentType: mime,
      putUrl,
      expiresAt,
    }),
  );
};

export const initiateAttachmentUpload = async (request: Request): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const me = authResult.user;
  const body = await parseJson<unknown>(request);
  const parsed = initiateAttachmentUploadSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(request, "Invalid attachment upload payload.");
  }

  const channelId = parsed.data.channel_id;

  const canView = await hasChannelPermission(me.id, channelId, PermissionBits.VIEW_CHANNEL);
  if (!canView) {
    return forbidden(request);
  }

  const canSend = await hasChannelPermission(me.id, channelId, PermissionBits.SEND_MESSAGES);
  if (!canSend) {
    return forbidden(request, "Missing SEND_MESSAGES.");
  }

  const access = await canAccessChannel(me.id, channelId);
  if (!access) {
    return forbidden(request);
  }

  if (access.channel.type === ChannelType.GUILD_CATEGORY) {
    return badRequest(request, "Cannot attach files in a category channel.");
  }

  const mime = normalizeMime(parsed.data.content_type);
  if (!isAttachmentMimeAllowed(mime)) {
    return badRequest(request, "Attachment content type is not allowed.");
  }

  if (parsed.data.size > env.UPLOAD_MAX_ATTACHMENT_BYTES) {
    return badRequest(request, `Attachment exceeds max upload size (${env.UPLOAD_MAX_ATTACHMENT_BYTES} bytes).`);
  }

  const uploadId = nextId();
  const key = makeObjectKey({
    kind: "attachments",
    userId: me.id,
    channelId,
    filename: parsed.data.filename,
  });
  const expiresAt = new Date(Date.now() + env.UPLOAD_PRESIGN_EXPIRES_SECONDS * 1_000);

  await db.insert(uploadSessions).values({
    id: uploadId,
    userId: me.id,
    kind: "attachment",
    status: "pending",
    s3Key: key,
    filename: parsed.data.filename,
    contentType: mime,
    expectedSize: parsed.data.size,
    channelId,
    messageId: null,
    expiresAt,
  });

  const putUrl = presignPut(key, {
    contentType: mime,
  });

  return json(
    request,
    buildUploadInitResponse({
      uploadId,
      key,
      contentType: mime,
      putUrl,
      expiresAt,
    }),
  );
};

export const completeUpload = async (request: BunRequest<"/api/uploads/:uploadId/complete">): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const me = authResult.user;
  const uploadId = request.params.uploadId;
  if (!uploadId) {
    return badRequest(request, "Invalid upload id.");
  }

  const session = await db.query.uploadSessions.findFirst({
    where: and(eq(uploadSessions.id, uploadId), eq(uploadSessions.userId, me.id)),
  });

  if (!session) {
    return notFound(request);
  }

  if (session.status !== "pending") {
    return badRequest(request, "Upload session is not pending.");
  }

  if (session.expiresAt.getTime() <= Date.now()) {
    await markSessionExpired(session.id);
    await bestEffortDeleteObject(session.s3Key);
    return badRequest(request, "Upload session has expired.");
  }

  let objectStat: Awaited<ReturnType<typeof statObject>>;
  try {
    objectStat = await statObject(session.s3Key);
  } catch {
    return badRequest(request, "Uploaded object was not found in storage.");
  }

  const detectedMime = normalizeMime(objectStat.type) || normalizeMime(session.contentType);

  if (session.kind === "avatar") {
    if (objectStat.size <= 0 || objectStat.size > env.UPLOAD_MAX_AVATAR_BYTES) {
      return badRequest(request, "Uploaded avatar size is invalid.");
    }

    if (!isMimeAllowed(detectedMime, env.UPLOAD_ALLOWED_AVATAR_MIME)) {
      return badRequest(request, "Uploaded avatar type is not allowed.");
    }

    await db
      .update(uploadSessions)
      .set({
        status: "completed",
        expectedSize: objectStat.size,
        contentType: detectedMime || session.contentType,
        completedAt: new Date(),
      })
      .where(eq(uploadSessions.id, session.id));

    const currentUser = await db.query.users.findFirst({ where: eq(users.id, me.id) });

    const resolvedAvatarUrl = avatarsArePublic ? toPublicObjectUrl(session.s3Key) : null;

    const [updatedUser] = await db
      .update(users)
      .set({
        avatarS3Key: session.s3Key,
        avatarUrl: resolvedAvatarUrl,
      })
      .where(eq(users.id, me.id))
      .returning();

    if (!updatedUser) {
      return notFound(request);
    }

    await db
      .update(userProfiles)
      .set({
        avatarUrl: resolvedAvatarUrl,
        updatedAt: new Date(),
      })
      .where(eq(userProfiles.userId, me.id));

    if (currentUser?.avatarS3Key && currentUser.avatarS3Key !== session.s3Key) {
      await bestEffortDeleteObject(currentUser.avatarS3Key);
    }

    const userSummary = (await getUserSummaryById(me.id)) ?? toUserSummary(updatedUser);
    await broadcastUserUpdate(me.id, userSummary);

    return json(request, {
      upload_id: session.id,
      kind: "avatar",
      user: toSummary(userSummary),
      avatar_s3_key: updatedUser.avatarS3Key,
    });
  }

  if (objectStat.size <= 0 || objectStat.size > env.UPLOAD_MAX_ATTACHMENT_BYTES) {
    return badRequest(request, "Uploaded attachment size is invalid.");
  }

  if (!isAttachmentMimeAllowed(detectedMime)) {
    return badRequest(request, "Uploaded attachment type is not allowed.");
  }

  await db
    .update(uploadSessions)
    .set({
      status: "completed",
      expectedSize: objectStat.size,
      contentType: detectedMime || session.contentType,
      completedAt: new Date(),
    })
    .where(eq(uploadSessions.id, session.id));

  return json(request, {
    upload_id: session.id,
    kind: "attachment",
    filename: session.filename,
    size: objectStat.size,
    content_type: detectedMime || session.contentType,
  });
};

export const abortUpload = async (request: BunRequest<"/api/uploads/:uploadId/abort">): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const me = authResult.user;
  const uploadId = request.params.uploadId;
  if (!uploadId) {
    return badRequest(request, "Invalid upload id.");
  }

  const session = await db.query.uploadSessions.findFirst({
    where: and(eq(uploadSessions.id, uploadId), eq(uploadSessions.userId, me.id)),
  });

  if (!session) {
    return notFound(request);
  }

  if (session.status === "pending") {
    await db
      .update(uploadSessions)
      .set({
        status: "aborted",
        completedAt: new Date(),
      })
      .where(eq(uploadSessions.id, session.id));

    await bestEffortDeleteObject(session.s3Key);
  }

  return empty(request, 204);
};

const cleanupExpiredPendingUploads = async (): Promise<void> => {
  const now = new Date();

  const expiredPendingRows = await db
    .select({
      id: uploadSessions.id,
      s3Key: uploadSessions.s3Key,
    })
    .from(uploadSessions)
    .where(and(eq(uploadSessions.status, "pending"), lt(uploadSessions.expiresAt, now)));

  for (const row of expiredPendingRows) {
    const [expired] = await db
      .update(uploadSessions)
      .set({
        status: "expired",
        completedAt: now,
      })
      .where(and(eq(uploadSessions.id, row.id), eq(uploadSessions.status, "pending")))
      .returning({ id: uploadSessions.id });

    if (expired) {
      await bestEffortDeleteObject(row.s3Key);
    }
  }

  const expiredCompletedAttachmentRows = await db
    .select({
      id: uploadSessions.id,
      s3Key: uploadSessions.s3Key,
    })
    .from(uploadSessions)
    .where(
      and(
        eq(uploadSessions.status, "completed"),
        eq(uploadSessions.kind, "attachment"),
        isNull(uploadSessions.messageId),
        lt(uploadSessions.expiresAt, now),
      ),
    );

  for (const row of expiredCompletedAttachmentRows) {
    const [expired] = await db
      .update(uploadSessions)
      .set({
        status: "expired",
        completedAt: now,
      })
      .where(
        and(
          eq(uploadSessions.id, row.id),
          eq(uploadSessions.status, "completed"),
          eq(uploadSessions.kind, "attachment"),
          isNull(uploadSessions.messageId),
        ),
      )
      .returning({ id: uploadSessions.id });

    if (expired) {
      await bestEffortDeleteObject(row.s3Key);
    }
  }
};

let uploadCleanupTimer: ReturnType<typeof setInterval> | null = null;

export const startUploadCleanupTask = (): void => {
  if (uploadCleanupTimer) {
    return;
  }

  void cleanupExpiredPendingUploads();
  uploadCleanupTimer = setInterval(() => {
    void cleanupExpiredPendingUploads();
  }, 15 * 60 * 1_000);
};
