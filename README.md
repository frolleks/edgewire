# Discord Clone (DM + Guild Text Channels)

Minimal Discord-like clone with:
- `apps/web`: React + TypeScript + Tailwind + shadcn/ui + React Router + React Query
- `apps/server`: Bun REST API + Bun WebSocket Gateway subset
- `apps/mediasoup-server`: TypeScript mediasoup SFU + signaling over WebSocket
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
- `apps/mediasoup-server` - mediasoup signaling + SFU
- `packages/types` - shared protocol/types
- `apps/voice-server` - legacy voice server (not used in default flow)

## 1) Prerequisites

- Bun `>=1.3`
- Node.js `>=22` (for `apps/mediasoup-server`)
- Docker + Docker Compose

## 2) Install Dependencies

```bash
bun install
```

## 3) Configure Environment

```bash
cp apps/server/.env.example apps/server/.env
cp apps/web/.env.example apps/web/.env
cp apps/mediasoup-server/.env.example apps/mediasoup-server/.env
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

Single command (server + web + mediasoup signaling):

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
bun run dev:mediasoup
```

`bun run dev:voice` starts the legacy voice server and is not part of the default mediasoup flow.

Default URLs:
- Web: `http://localhost:3000`
- API/Gateway: `http://localhost:3001`
- Voice signaling WS: `ws://localhost:4000/ws`

### Voice/Screenshare Environment

Set these in `apps/server/.env` (and share the secrets with `apps/mediasoup-server/.env`):

- `VOICE_TOKEN_SECRET` - HMAC secret used by API and voice signaling server
- `VOICE_INTERNAL_SECRET` - shared secret for mediasoup-server -> API internal state sync
- `MEDIASOUP_WS_URL` - signaling websocket URL returned by `/api/voice/token`
  - Do not leave this as `localhost` if users connect from other devices/browsers on your LAN. Use your server host/IP.
- `ICE_SERVERS_JSON` - JSON array of ICE servers, example:

```json
[{"urls":["stun:stun.l.google.com:19302"]}]
```

Set these in `apps/web/.env`:

- `BUN_PUBLIC_USE_MEDIASOUP_VOICE=true`
- `BUN_PUBLIC_DEBUG_VOICE=true|false` - verbose client voice logs

Set these in `apps/mediasoup-server/.env`:

- `API_BASE_URL` - Bun API base URL used for internal voice state sync
- `VOICE_TOKEN_SECRET` - must match `apps/server/.env`
- `VOICE_INTERNAL_SECRET` - must match `apps/server/.env`
- `DEBUG_VOICE=true|false` - verbose mediasoup signaling logs
- `MEDIASOUP_LISTEN_IP`
- `MEDIASOUP_ANNOUNCED_ADDRESS`
- `MEDIASOUP_MIN_PORT` / `MEDIASOUP_MAX_PORT`
- `MEDIASOUP_INITIAL_AVAILABLE_OUTGOING_BITRATE` (default `1000000`)
- `ICE_TRANSPORT_POLICY` (optional `all` or `relay`)

Mediasoup-only networking (no TURN):

- For local same-machine testing: `MEDIASOUP_LISTEN_IP=127.0.0.1`
- For LAN/public clients: `MEDIASOUP_LISTEN_IP=0.0.0.0` and set `MEDIASOUP_ANNOUNCED_ADDRESS` to the reachable host/IP.
- Open firewall/security groups for:
  - signaling `4000/tcp`
  - mediasoup RTP/ICE ports `MEDIASOUP_MIN_PORT..MEDIASOUP_MAX_PORT` (UDP and TCP)

If `ICE failed` appears and mediasoup logs show candidates with `ip: 127.0.0.1`, `MEDIASOUP_ANNOUNCED_ADDRESS` is wrong/missing for your client network.

### Voice Signaling Protocol (mediasoup)

WebSocket envelope:

- Request: `{ id, method, data? }`
- Success response: `{ id, ok: true, data }`
- Error response: `{ id, ok: false, error: { code, message } }`
- Notification: `{ notification: true, method, data }`

Methods:

- `identify` - validates Bun-issued voice token and binds `{ userId, roomId }` to session
- `join` - joins room, returns `routerRtpCapabilities`, existing peers, existing producers
- `createWebRtcTransport`
- `connectWebRtcTransport`
- `produce`
- `consume` - server creates consumer with `paused: true`
- `resumeConsumer` - resumes consumer; video consumers request keyframe
- `closeProducer`
- `leave`
- `updatePeerState`

Notifications:

- `peerJoined`
- `peerLeft`
- `newProducer`
- `producerClosed`
- `peerStateUpdated`

Client lifecycle:

1. `POST /api/voice/token`
2. WS `identify`
3. WS `join`
4. `device.load({ routerRtpCapabilities })`
5. Create recv transport, then send transport
6. Produce mic/screen only if `device.canProduce(kind)`
7. Consume flow: request `consume` with `device.recvRtpCapabilities`, create local consumer, attach track to media element, then call `resumeConsumer`

Remote media behavior:

- Remote audio is attached to `<audio autoplay playsinline>` and `play()` is invoked.
- Remote screenshare is attached to `<video autoplay muted playsinline>` and `play()` is invoked.
- If autoplay is blocked, UI shows one-click `Enable audio`.

Debug logging (`DEBUG_VOICE`):

- Server logs identify/join, transport create/connect, produce, consume (`canConsume`), resume, and producer close.
- Client logs join/device load, transport connect/state changes, produce, consume, resume ack, and media `play()` success/failure.

## 7) Production Build

```bash
bun run build
bun run start:server
bun run start:mediasoup
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

### Voice
- `POST /api/voice/token`
- `GET /api/guilds/:guildId/voice-state`
- `POST /api/internal/voice/state` (internal, secret-protected)

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
