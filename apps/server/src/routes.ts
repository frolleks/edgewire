import { handleAuth } from "./controllers/auth";
import { createTyping, deleteChannel, patchChannel, updateReadState } from "./controllers/channels";
import { apiNotFoundAfterAuth, internalServerError } from "./controllers/common";
import { createToken } from "./controllers/gateway";
import { createGuild, createGuildChannel, getGuild, getGuildChannels } from "./controllers/guilds";
import { getHealth } from "./controllers/health";
import { acceptInvite, createChannelInvite, getInvite } from "./controllers/invites";
import { createMyChannel, getMe, listMyChannels, listMyGuilds, updateMeProfile } from "./controllers/me";
import {
  createChannelMessage,
  deleteChannelMessage,
  getChannelMessages,
  updateChannelMessage,
} from "./controllers/messages";
import { searchUsers } from "./controllers/users";
import { corsPreflight, methodNotAllowed } from "./http";

type Handler = (request: Request) => Response | Promise<Response>;

const safe = (handler: Handler): Handler => {
  return async request => {
    try {
      return await handler(request);
    } catch (error) {
      console.error("Unhandled API error", error);
      return internalServerError(request);
    }
  };
};

const notAllowed = (allowed: string[]): Handler => safe((request: Request) => methodNotAllowed(request, allowed));
const auth404 = safe(apiNotFoundAfterAuth);

export const routes = {
  "/api/auth/*": {
    GET: safe(handleAuth),
    POST: safe(handleAuth),
    PUT: safe(handleAuth),
    PATCH: safe(handleAuth),
    DELETE: safe(handleAuth),
    OPTIONS: corsPreflight,
  },
  "/api/health": {
    GET: safe(getHealth),
    POST: auth404,
    PUT: auth404,
    PATCH: auth404,
    DELETE: auth404,
    OPTIONS: corsPreflight,
  },
  "/api/users/@me": {
    GET: safe(getMe),
    POST: auth404,
    PUT: auth404,
    PATCH: auth404,
    DELETE: auth404,
    OPTIONS: corsPreflight,
  },
  "/api/users/@me/profile": {
    PUT: safe(updateMeProfile),
    GET: auth404,
    POST: auth404,
    PATCH: auth404,
    DELETE: auth404,
    OPTIONS: corsPreflight,
  },
  "/api/users": {
    GET: safe(searchUsers),
    POST: auth404,
    PUT: auth404,
    PATCH: auth404,
    DELETE: auth404,
    OPTIONS: corsPreflight,
  },
  "/api/users/@me/channels": {
    GET: safe(listMyChannels),
    POST: safe(createMyChannel),
    PUT: auth404,
    PATCH: auth404,
    DELETE: auth404,
    OPTIONS: corsPreflight,
  },
  "/api/users/@me/guilds": {
    GET: safe(listMyGuilds),
    POST: auth404,
    PUT: auth404,
    PATCH: auth404,
    DELETE: auth404,
    OPTIONS: corsPreflight,
  },
  "/api/guilds": {
    POST: safe(createGuild),
    GET: auth404,
    PUT: auth404,
    PATCH: auth404,
    DELETE: auth404,
    OPTIONS: corsPreflight,
  },
  "/api/guilds/:guildId": {
    GET: safe(getGuild as Handler),
    POST: auth404,
    PUT: auth404,
    PATCH: auth404,
    DELETE: auth404,
    OPTIONS: corsPreflight,
  },
  "/api/guilds/:guildId/channels": {
    GET: safe(getGuildChannels as Handler),
    POST: safe(createGuildChannel as Handler),
    PUT: notAllowed(["GET", "POST"]),
    PATCH: notAllowed(["GET", "POST"]),
    DELETE: notAllowed(["GET", "POST"]),
    OPTIONS: corsPreflight,
  },
  "/api/channels/:channelId": {
    PATCH: safe(patchChannel as Handler),
    DELETE: safe(deleteChannel as Handler),
    GET: notAllowed(["PATCH", "DELETE"]),
    POST: notAllowed(["PATCH", "DELETE"]),
    PUT: notAllowed(["PATCH", "DELETE"]),
    OPTIONS: corsPreflight,
  },
  "/api/channels/:channelId/messages": {
    GET: safe(getChannelMessages as Handler),
    POST: safe(createChannelMessage as Handler),
    PUT: notAllowed(["GET", "POST"]),
    PATCH: notAllowed(["GET", "POST"]),
    DELETE: notAllowed(["GET", "POST"]),
    OPTIONS: corsPreflight,
  },
  "/api/channels/:channelId/messages/:messageId": {
    PATCH: safe(updateChannelMessage as Handler),
    DELETE: safe(deleteChannelMessage as Handler),
    GET: notAllowed(["PATCH", "DELETE"]),
    POST: notAllowed(["PATCH", "DELETE"]),
    PUT: notAllowed(["PATCH", "DELETE"]),
    OPTIONS: corsPreflight,
  },
  "/api/channels/:channelId/typing": {
    POST: safe(createTyping as Handler),
    GET: auth404,
    PUT: auth404,
    PATCH: auth404,
    DELETE: auth404,
    OPTIONS: corsPreflight,
  },
  "/api/channels/:channelId/read": {
    PUT: safe(updateReadState as Handler),
    GET: auth404,
    POST: auth404,
    PATCH: auth404,
    DELETE: auth404,
    OPTIONS: corsPreflight,
  },
  "/api/channels/:channelId/invites": {
    POST: safe(createChannelInvite as Handler),
    GET: auth404,
    PUT: auth404,
    PATCH: auth404,
    DELETE: auth404,
    OPTIONS: corsPreflight,
  },
  "/api/invites/:code": {
    GET: safe(getInvite as Handler),
    POST: auth404,
    PUT: auth404,
    PATCH: auth404,
    DELETE: auth404,
    OPTIONS: corsPreflight,
  },
  "/api/invites/:code/accept": {
    POST: safe(acceptInvite as Handler),
    GET: auth404,
    PUT: auth404,
    PATCH: auth404,
    DELETE: auth404,
    OPTIONS: corsPreflight,
  },
  "/api/gateway/token": {
    POST: safe(createToken),
    GET: auth404,
    PUT: auth404,
    PATCH: auth404,
    DELETE: auth404,
    OPTIONS: corsPreflight,
  },
  "/api/*": {
    GET: auth404,
    POST: auth404,
    PUT: auth404,
    PATCH: auth404,
    DELETE: auth404,
    OPTIONS: corsPreflight,
  },
} as const;
