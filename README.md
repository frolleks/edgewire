# Discord Clone (DM + Guild Text Channels)

Minimal Discord-like clone with:
- `apps/web`: React + TypeScript + Tailwind + shadcn/ui + React Router + React Query
- `apps/server`: Bun REST API + Bun WebSocket Gateway subset
- PostgreSQL + Drizzle ORM migrations
- Better Auth (email/password + secure-cookie sessions)

Implemented scope:
- 1:1 DMs
- Guilds (servers)
- Guild categories + text channels
- Guild roles + member role assignment
- Guild/server settings update flow
- User settings (account, profile, appearance)
- Channel permission overwrites
- Permission-aware route enforcement (guild + channel)
- Sidebar category/channel drag-and-drop reorder + move
- Invite create/preview/accept flow
- Real-time dispatch for guild/channel/message lifecycle

## Monorepo Layout

- `apps/web` - frontend
- `apps/server` - backend API + gateway
- `packages/types` - shared protocol/types

## 1) Prerequisites

- Bun `>=1.3`
- Docker + Docker Compose

## 2) Install Dependencies

```bash
bun install
```

## 3) Configure Environment

```bash
cp apps/server/.env.example apps/server/.env
cp apps/web/.env.example apps/web/.env
```

For S3 uploads, configure the `S3_*`/`AWS_*` credentials plus upload limits in `apps/server/.env`.

## 4) Start PostgreSQL

```bash
docker compose up -d
```

## 5) Migrations

Generate Better Auth schema file (already committed, command kept for workflow):

```bash
bun run auth:generate
```

Apply migrations (includes DM -> unified `channels` migration + guild tables):

```bash
bun run db:migrate
```

Latest migration also adds:
- `user_profiles`
- `user_settings`
- `user_theme` enum

Optional:

```bash
bun run db:studio
```

## 6) Run in Development

Single command (server + web + voice signaling):

```bash
bun run dev
```

Separate terminals:

Terminal 1:
```bash
bun run dev:server
```

Terminal 2:
```bash
bun run dev:web
```

Terminal 3:
```bash
bun run dev:voice
```

Default URLs:
- Web: `http://localhost:3000`
- API/Gateway: `http://localhost:3001`
- Voice signaling WS: `ws://localhost:3002/ws`

### Voice/Screenshare Environment

Set these in `apps/server/.env` (and share the secret with `apps/voice-server/.env`):

- `VOICE_TOKEN_SECRET` - HMAC secret used by API and voice signaling server
- `VOICE_INTERNAL_SECRET` - shared secret for voice-server -> API internal state sync
- `VOICE_WS_URL` - signaling websocket URL returned by `/api/voice/token`
- `ICE_SERVERS_JSON` - JSON array of ICE servers, example:

```json
[{"urls":["stun:stun.l.google.com:19302"]}]
```

For production voice/screen reliability, configure TURN (for example coturn) in `ICE_SERVERS_JSON`.
Also set `API_BASE_URL` and `VOICE_INTERNAL_SECRET` in `apps/voice-server/.env`.

## 7) Production Build

```bash
bun run build
bun run start:server
```

## 8) Smoke Script

Run against a running local server to validate guild flows + gateway fanout:

```bash
bun run smoke
```

## REST API Subset

All routes require authentication except Better Auth endpoints.

### Routing Structure
- Bun routing is defined with `Bun.serve({ routes })` in `apps/server/src/index.ts`.
- Route patterns and per-method handlers live in `apps/server/src/routes.ts`.
- Domain route handlers/controllers live in `apps/server/src/controllers/`.
- Shared HTTP response/CORS/auth helpers live in `apps/server/src/http/index.ts`.
- WebSocket upgrades for `/gateway` and `/api/gateway` stay in the `fetch(req, server)` fallback in `apps/server/src/index.ts`.

### Auth
- `GET/POST /api/auth/*` (Better Auth handler)

### Users
- `GET /api/users/@me`
- `PATCH /api/users/@me`
- `PUT /api/users/@me/profile`
- `PATCH /api/users/@me/settings`
- `POST /api/users/@me/avatar`
- `GET /api/users?q=...`

### DM Channels
- `GET /api/users/@me/channels`
- `POST /api/users/@me/channels`

### Guilds
- `POST /api/guilds`
- `GET /api/users/@me/guilds`
- `GET /api/guilds/:guildId`
- `PATCH /api/guilds/:guildId`
- `GET /api/guilds/:guildId/channels`
- `POST /api/guilds/:guildId/channels`
- `PATCH /api/guilds/:guildId/channels`
- `GET /api/guilds/:guildId/members`
- `GET /api/guilds/:guildId/permissions/@me`

### Roles
- `GET /api/guilds/:guildId/roles`
- `POST /api/guilds/:guildId/roles`
- `PATCH /api/guilds/:guildId/roles` (bulk reorder)
- `PATCH /api/guilds/:guildId/roles/:roleId`
- `DELETE /api/guilds/:guildId/roles/:roleId`
- `PUT /api/guilds/:guildId/members/:userId/roles/:roleId`
- `DELETE /api/guilds/:guildId/members/:userId/roles/:roleId`

### Channels
- `PATCH /api/channels/:channelId`
- `DELETE /api/channels/:channelId`
- `PUT /api/channels/:channelId/permissions/:overwriteId`
- `DELETE /api/channels/:channelId/permissions/:overwriteId`

### Messages
- `GET /api/channels/:channelId/messages?limit=50&before=:messageId`
- `POST /api/channels/:channelId/messages` (`content` and optional `attachment_upload_ids`)
- `PATCH /api/channels/:channelId/messages/:messageId`
- `DELETE /api/channels/:channelId/messages/:messageId`

### Uploads (S3 direct upload)
- `POST /api/uploads/avatar`
- `POST /api/uploads/attachment`
- `POST /api/uploads/:uploadId/complete`
- `POST /api/uploads/:uploadId/abort`

### Typing + Read
- `POST /api/channels/:channelId/typing`
- `PUT /api/channels/:channelId/read`

### Invites
- `POST /api/channels/:channelId/invites`
- `GET /api/invites/:code?with_counts=true|false`
- `POST /api/invites/:code/accept`

### Gateway Auth Token
- `POST /api/gateway/token`

## Gateway Subset

Endpoint:
- `/gateway` (also accepts `/api/gateway`)

Supported opcodes:
- `10 HELLO`
- `1 HEARTBEAT`
- `11 HEARTBEAT_ACK`
- `2 IDENTIFY`
- `6 RESUME`
- `9 INVALID_SESSION`
- `0 DISPATCH`

Dispatch events:
- `READY`
- `GUILD_CREATE`
- `GUILD_UPDATE`
- `GUILD_ROLE_CREATE`
- `GUILD_ROLE_UPDATE`
- `GUILD_ROLE_DELETE`
- `GUILD_MEMBER_UPDATE`
- `CHANNEL_CREATE`
- `CHANNEL_UPDATE`
- `CHANNEL_DELETE`
- `MESSAGE_CREATE`
- `MESSAGE_UPDATE`
- `MESSAGE_DELETE`
- `TYPING_START`
- `READ_STATE_UPDATE`
- `USER_UPDATE`
- `USER_SETTINGS_UPDATE`

READY behavior:
- includes `private_channels` (DMs)
- includes `guilds` as unavailable stubs
- followed by per-guild `GUILD_CREATE` backfill

## Data Model Notes

- Unified `channels` table:
  - `type=1` DM
  - `type=0` guild text
  - `type=4` guild category
- `guild_roles` table stores Discord-like role fields; `@everyone` is created per guild with `id=guild_id`.
- `guild_member_roles` stores many-to-many member role assignments (with implicit `@everyone`).
- `channel_permission_overwrites` stores per-channel role/member overwrites (`allow`/`deny` as stringified bitfields).
- Better Auth identity remains canonical in `auth_users` (`id`, `email`, `name`, `image`).
- App-owned user data is stored in:
  - `user_profiles` (username + profile fields)
  - `user_settings` (theme, compact mode, timestamps, locale)
- Legacy `users` remains for existing foreign keys/joins and is kept in sync with profile identity fields.
- Guild access is enforced via `guild_members`.
- DM access is enforced via `channel_members`.
- Permission math uses `BigInt` with Discord-like overwrite ordering.
- IDs are snowflake-like values serialized as strings.
- Better Auth Drizzle mapping keys are snake_case (`auth_users`, `auth_sessions`, `auth_accounts`, `auth_verifications`).

## User Settings + Upload Notes

- `GET /api/users/@me` returns merged account/profile/preferences data.
- `PATCH /api/users/@me` updates profile/account fields for the authenticated user only.
- `PATCH /api/users/@me/settings` updates appearance/preferences and dispatches `USER_SETTINGS_UPDATE` to the user's own sessions.
- Avatar upload init is available at `POST /api/users/@me/avatar` (alias to upload init flow), completed via `POST /api/uploads/:uploadId/complete`.
- Avatar URL resolution uses either `FILES_PUBLIC_BASE_URL` public URLs or presigned download URLs from stored object keys.
- Storage object paths use `avatars/<userId>/...` for avatars and `attachments/<channelOrUser>/<year>/<month>/...` for attachments.
