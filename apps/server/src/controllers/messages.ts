import { ChannelType } from "@discord/types";
import type { BunRequest } from "bun";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db";
import { messageAttachments, messages, uploadSessions } from "../db/schema";
import { badRequest, empty, forbidden, json, notFound, parseJson, requireAuth } from "../http";
import { PermissionBits } from "../lib/permissions";
import { hasChannelPermission } from "../lib/permission-service";
import {
  canAccessChannel,
  createMessageSchema,
  editMessageSchema,
  emitToChannelAudience,
  listChannelMessages,
  listMessageAttachmentPayloads,
  makeMessagePayload,
  nextId,
  parseSnowflake,
  toAttachmentPayload,
  toSummary,
} from "../runtime";

export const getChannelMessages = async (request: BunRequest<"/api/channels/:channelId/messages">): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const me = authResult.user;
  const channelId = request.params.channelId;
  if (!channelId) {
    return badRequest(request, "Invalid channel id.");
  }

  const canView = await hasChannelPermission(me.id, channelId, PermissionBits.VIEW_CHANNEL);
  if (!canView) {
    return forbidden(request);
  }

  const canReadHistory = await hasChannelPermission(me.id, channelId, PermissionBits.READ_MESSAGE_HISTORY);
  if (!canReadHistory) {
    return forbidden(request, "Missing READ_MESSAGE_HISTORY.");
  }

  const access = await canAccessChannel(me.id, channelId);
  if (!access) {
    return forbidden(request);
  }

  if (access.channel.type === ChannelType.GUILD_CATEGORY) {
    return badRequest(request, "Cannot send messages to a category channel.");
  }

  const searchParams = new URL(request.url).searchParams;
  const limit = Number(searchParams.get("limit") ?? 50);
  const beforeRaw = searchParams.get("before");
  const before = beforeRaw ? parseSnowflake(beforeRaw) : null;
  if (beforeRaw && before === null) {
    return badRequest(request, "Invalid before message id.");
  }

  const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 100)) : 50;
  const items = await listChannelMessages(channelId, boundedLimit, before ?? undefined);
  return json(request, items);
};

export const createChannelMessage = async (request: BunRequest<"/api/channels/:channelId/messages">): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const me = authResult.user;
  const channelId = request.params.channelId;
  if (!channelId) {
    return badRequest(request, "Invalid channel id.");
  }

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
    return badRequest(request, "Cannot send messages to a category channel.");
  }

  const body = await parseJson<unknown>(request);
  const parsed = createMessageSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(request, "Invalid message payload.");
  }

  const content = parsed.data.content?.trim() ?? "";
  const attachmentUploadIds = [...new Set(parsed.data.attachment_upload_ids ?? [])];
  const now = new Date();

  const uploadRows =
    attachmentUploadIds.length === 0
      ? []
      : await db
          .select()
          .from(uploadSessions)
          .where(and(eq(uploadSessions.userId, me.id), inArray(uploadSessions.id, attachmentUploadIds)));

  if (uploadRows.length !== attachmentUploadIds.length) {
    return badRequest(request, "One or more attachment uploads were not found.");
  }

  const uploadsById = new Map(uploadRows.map(row => [row.id, row]));
  const orderedUploads = attachmentUploadIds
    .map(uploadId => uploadsById.get(uploadId))
    .filter((upload): upload is typeof uploadSessions.$inferSelect => Boolean(upload));
  if (orderedUploads.length !== attachmentUploadIds.length) {
    return badRequest(request, "One or more attachment uploads were not found.");
  }

  for (const upload of orderedUploads) {
    if (
      upload.kind !== "attachment" ||
      upload.status !== "completed" ||
      upload.channelId !== channelId ||
      upload.messageId !== null
    ) {
      return badRequest(request, "One or more attachment uploads are not valid for this message.");
    }

    if (upload.expiresAt.getTime() <= now.getTime()) {
      return badRequest(request, "One or more attachment uploads have expired.");
    }

    if (!upload.expectedSize || upload.expectedSize <= 0) {
      return badRequest(request, "One or more attachment uploads are missing file metadata.");
    }
  }

  let createdMessage: typeof messages.$inferSelect | null = null;
  let createdAttachments: Array<typeof messageAttachments.$inferSelect> = [];

  try {
    await db.transaction(async tx => {
      const [created] = await tx
        .insert(messages)
        .values({
          id: nextId(),
          channelId,
          authorId: me.id,
          content,
        })
        .returning();

      if (!created) {
        throw new Error("Failed to create message.");
      }

      createdMessage = created;

      if (orderedUploads.length === 0) {
        return;
      }

      createdAttachments = await tx
        .insert(messageAttachments)
        .values(
          orderedUploads.map(upload => ({
            id: nextId(),
            messageId: created.id,
            channelId,
            uploaderId: me.id,
            s3Key: upload.s3Key,
            filename: upload.filename,
            size: upload.expectedSize ?? 0,
            contentType: upload.contentType,
            urlKind: "presigned",
          })),
        )
        .returning();

      const boundRows = await tx
        .update(uploadSessions)
        .set({ messageId: created.id })
        .where(
          and(
            eq(uploadSessions.userId, me.id),
            eq(uploadSessions.kind, "attachment"),
            eq(uploadSessions.status, "completed"),
            eq(uploadSessions.channelId, channelId),
            isNull(uploadSessions.messageId),
            inArray(uploadSessions.id, orderedUploads.map(upload => upload.id)),
          ),
        )
        .returning({ id: uploadSessions.id });

      if (boundRows.length !== orderedUploads.length) {
        throw new Error("One or more attachment uploads were already consumed.");
      }
    });
  } catch (error) {
    return badRequest(request, error instanceof Error ? error.message : "Failed to create message.");
  }

  if (!createdMessage) {
    return badRequest(request, "Failed to create message.");
  }

  const payload = makeMessagePayload(
    createdMessage,
    toSummary(me),
    access.channel.guildId ?? null,
    createdAttachments.map(toAttachmentPayload),
  );
  await emitToChannelAudience(access.channel, "MESSAGE_CREATE", payload);

  return json(request, payload, { status: 201 });
};

export const updateChannelMessage = async (
  request: BunRequest<"/api/channels/:channelId/messages/:messageId">,
): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const me = authResult.user;
  const channelId = request.params.channelId;
  const messageId = request.params.messageId;
  if (!channelId || !messageId) {
    return badRequest(request, "Invalid channel id or message id.");
  }

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

  const message = await db.query.messages.findFirst({
    where: and(eq(messages.id, messageId), eq(messages.channelId, channelId)),
  });

  if (!message) {
    return notFound(request);
  }

  if (message.authorId !== me.id) {
    return forbidden(request, "Only the author can modify this message.");
  }

  const body = await parseJson<unknown>(request);
  const parsed = editMessageSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(request, "content must be between 1 and 2000 characters.");
  }

  const [updated] = await db
    .update(messages)
    .set({
      content: parsed.data.content,
      editedAt: new Date(),
    })
    .where(and(eq(messages.id, messageId), eq(messages.channelId, channelId)))
    .returning();

  if (!updated) {
    return notFound(request);
  }

  const attachmentsByMessage = await listMessageAttachmentPayloads([updated.id]);
  const payload = makeMessagePayload(
    updated,
    toSummary(me),
    access.channel.guildId ?? null,
    attachmentsByMessage.get(updated.id) ?? [],
  );
  await emitToChannelAudience(access.channel, "MESSAGE_UPDATE", payload);
  return json(request, payload);
};

export const deleteChannelMessage = async (
  request: BunRequest<"/api/channels/:channelId/messages/:messageId">,
): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const me = authResult.user;
  const channelId = request.params.channelId;
  const messageId = request.params.messageId;
  if (!channelId || !messageId) {
    return badRequest(request, "Invalid channel id or message id.");
  }

  const canView = await hasChannelPermission(me.id, channelId, PermissionBits.VIEW_CHANNEL);
  if (!canView) {
    return forbidden(request);
  }

  const access = await canAccessChannel(me.id, channelId);
  if (!access) {
    return forbidden(request);
  }

  const message = await db.query.messages.findFirst({
    where: and(eq(messages.id, messageId), eq(messages.channelId, channelId)),
  });

  if (!message) {
    return notFound(request);
  }

  if (message.authorId !== me.id) {
    if (access.scope === "DM") {
      return forbidden(request, "Only the author can modify this message.");
    }

    const canManageMessages = await hasChannelPermission(
      me.id,
      channelId,
      PermissionBits.MANAGE_MESSAGES,
    );

    if (!canManageMessages) {
      return forbidden(request, "Missing MANAGE_MESSAGES.");
    }
  }

  await db.delete(messages).where(and(eq(messages.id, messageId), eq(messages.channelId, channelId)));

  await emitToChannelAudience(access.channel, "MESSAGE_DELETE", {
    id: messageId,
    channel_id: channelId,
    guild_id: access.channel.guildId ?? null,
  });
  return empty(request, 204);
};
