import { ChannelType } from "@edgewire/types";
import type { BunRequest } from "bun";
import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { channelReads, messageAttachments, messageMentions, messages, uploadSessions } from "../db/schema";
import { badRequest, empty, forbidden, json, notFound, parseJson, requireAuth } from "../http";
import { emitBadgeUpdatesForUsers } from "../lib/badges";
import { getDmNotificationSettings, getGuildNotificationSettings, resolveMentionsForChannel } from "../lib/mentions";
import { PermissionBits } from "../lib/permissions";
import { hasChannelPermission } from "../lib/permission-service";
import {
  buildMessageMentionContext,
  canAccessChannel,
  createMessageSchema,
  editMessageSchema,
  emitToChannelAudience,
  emitToUsers,
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

  if (access.channel.type === ChannelType.GUILD_CATEGORY || access.channel.type === ChannelType.GUILD_VOICE) {
    return badRequest(request, "Cannot send messages to this channel type.");
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

  const access = await canAccessChannel(me.id, channelId);
  if (!access) {
    return forbidden(request);
  }

  if (access.channel.type === ChannelType.GUILD_CATEGORY || access.channel.type === ChannelType.GUILD_VOICE) {
    return badRequest(request, "Cannot send messages to this channel type.");
  }

  const body = await parseJson<unknown>(request);
  const parsed = createMessageSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(request, "Invalid message payload.");
  }

  const content = parsed.data.content?.trim() ?? "";
  const mentionResolution = await resolveMentionsForChannel({
    channel: access.channel,
    authorId: me.id,
    content,
    allowedMentions: parsed.data.allowed_mentions,
  });
  const recipientUserIds = mentionResolution.audienceUserIds.filter(userId => userId !== me.id);
  const directMentionSet = new Set(mentionResolution.directMentionUserIds);
  const roleMentionSet = new Set(mentionResolution.roleMentionUserIds);
  const everyoneMentionSet = new Set(mentionResolution.everyoneMentionUserIds);

  const notificationSettings =
    access.scope === "DM"
      ? await getDmNotificationSettings(recipientUserIds, channelId)
      : await getGuildNotificationSettings(recipientUserIds, access.channel.guildId!, channelId);

  const mentionByRecipient = new Map<string, boolean>();
  const notifyByRecipient = new Map<string, boolean>();
  for (const recipientId of recipientUserIds) {
    const settings = notificationSettings.get(recipientId) ?? {
      level: access.scope === "DM" ? "ALL_MESSAGES" : "ONLY_MENTIONS",
      muted: false,
      suppressEveryone: false,
    };

    const everyoneMention = everyoneMentionSet.has(recipientId) && !settings.suppressEveryone;
    const isMentioned = directMentionSet.has(recipientId) || roleMentionSet.has(recipientId) || everyoneMention;
    mentionByRecipient.set(recipientId, isMentioned);

    let shouldNotify = false;
    if (!settings.muted) {
      if (settings.level === "ALL_MESSAGES") {
        shouldNotify = true;
      } else if (settings.level === "ONLY_MENTIONS") {
        shouldNotify = isMentioned;
      }
    }
    notifyByRecipient.set(recipientId, shouldNotify);
  }

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
          mentionEveryone: mentionResolution.mentionEveryone,
          mentionUserIds: mentionResolution.mentionUserIds,
          mentionRoleIds: mentionResolution.mentionRoleIds,
          mentionChannelIds: mentionResolution.mentionChannelIds,
        })
        .returning();

      if (!created) {
        throw new Error("Failed to create message.");
      }

      createdMessage = created;

      if (orderedUploads.length > 0) {
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
      }

      const mentionedRecipients = recipientUserIds.filter(userId => mentionByRecipient.get(userId));
      if (mentionedRecipients.length > 0) {
        await tx.insert(messageMentions).values(
          mentionedRecipients.map(userId => ({
            messageId: created.id,
            channelId,
            guildId: access.channel.guildId ?? null,
            mentionedUserId: userId,
          })),
        );
      }

      for (const recipientId of recipientUserIds) {
        const mentionIncrement = mentionByRecipient.get(recipientId) ? 1 : 0;
        await tx
          .insert(channelReads)
          .values({
            userId: recipientId,
            channelId,
            lastReadMessageId: null,
            unreadCount: 1,
            mentionCount: mentionIncrement,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [channelReads.userId, channelReads.channelId],
            set: {
              unreadCount: sql`${channelReads.unreadCount} + 1`,
              mentionCount: sql`${channelReads.mentionCount} + ${mentionIncrement}`,
              updatedAt: new Date(),
            },
          });
      }
    });
  } catch (error) {
    return badRequest(request, error instanceof Error ? error.message : "Failed to create message.");
  }

  if (!createdMessage) {
    return badRequest(request, "Failed to create message.");
  }

  const mentionContext = await buildMessageMentionContext([createdMessage]);
  const payload = makeMessagePayload(
    createdMessage,
    toSummary(me),
    access.channel.guildId ?? null,
    createdAttachments.map(toAttachmentPayload),
    mentionContext,
  );
  emitToUsers(mentionResolution.audienceUserIds, "MESSAGE_CREATE", payload);
  await emitBadgeUpdatesForUsers(recipientUserIds, channelId, createdMessage.id);

  for (const recipientId of recipientUserIds) {
    if (!notifyByRecipient.get(recipientId)) {
      continue;
    }

    emitToUsers([recipientId], "NOTIFICATION_CREATE", {
      channel_id: channelId,
      guild_id: access.channel.guildId ?? null,
      message_id: createdMessage.id,
      author: toSummary(me),
      mentioned: mentionByRecipient.get(recipientId) ?? false,
    });
  }

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
    return badRequest(request, "content must be between 0 and 2000 characters.");
  }

  const nextContent = parsed.data.content;
  const [attachmentCountRow] = await db
    .select({ value: count() })
    .from(messageAttachments)
    .where(eq(messageAttachments.messageId, messageId));
  const hasAttachments = Number(attachmentCountRow?.value ?? 0) > 0;
  if (!nextContent.trim() && !hasAttachments) {
    return badRequest(request, "Message must include content or attachments.");
  }

  const mentionResolution = await resolveMentionsForChannel({
    channel: access.channel,
    authorId: me.id,
    content: nextContent,
    allowedMentions: parsed.data.allowed_mentions,
  });
  const mentionRecipients = [...new Set([
    ...mentionResolution.directMentionUserIds,
    ...mentionResolution.roleMentionUserIds,
    ...mentionResolution.everyoneMentionUserIds,
  ])];

  let updated: typeof messages.$inferSelect | null = null;
  await db.transaction(async tx => {
    const [next] = await tx
      .update(messages)
      .set({
        content: nextContent,
        editedAt: new Date(),
        mentionEveryone: mentionResolution.mentionEveryone,
        mentionUserIds: mentionResolution.mentionUserIds,
        mentionRoleIds: mentionResolution.mentionRoleIds,
        mentionChannelIds: mentionResolution.mentionChannelIds,
      })
      .where(and(eq(messages.id, messageId), eq(messages.channelId, channelId)))
      .returning();

    if (!next) {
      return;
    }

    updated = next;

    await tx.delete(messageMentions).where(and(eq(messageMentions.messageId, messageId), eq(messageMentions.channelId, channelId)));

    if (mentionRecipients.length > 0) {
      await tx.insert(messageMentions).values(
        mentionRecipients.map(userId => ({
          messageId,
          channelId,
          guildId: access.channel.guildId ?? null,
          mentionedUserId: userId,
        })),
      );
    }
  });

  if (!updated) {
    return notFound(request);
  }

  const attachmentsByMessage = await listMessageAttachmentPayloads([updated.id]);
  const mentionContext = await buildMessageMentionContext([updated]);
  const payload = makeMessagePayload(
    updated,
    toSummary(me),
    access.channel.guildId ?? null,
    attachmentsByMessage.get(updated.id) ?? [],
    mentionContext,
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
