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

Optional:

```bash
bun run db:studio
```

## 6) Run in Development

Single command (server + web):

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

Default URLs:
- Web: `http://localhost:3000`
- API/Gateway: `http://localhost:3001`

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
- `PUT /api/users/@me/profile`
- `GET /api/users?q=...`

### DM Channels
- `GET /api/users/@me/channels`
- `POST /api/users/@me/channels`

### Guilds
- `POST /api/guilds`
- `GET /api/users/@me/guilds`
- `GET /api/guilds/:guildId`
- `GET /api/guilds/:guildId/channels`
- `POST /api/guilds/:guildId/channels` (owner only)

### Channels
- `PATCH /api/channels/:channelId` (guild owner for guild channels)
- `DELETE /api/channels/:channelId` (guild owner for guild channels)

### Messages
- `GET /api/channels/:channelId/messages?limit=50&before=:messageId`
- `POST /api/channels/:channelId/messages`
- `PATCH /api/channels/:channelId/messages/:messageId`
- `DELETE /api/channels/:channelId/messages/:messageId`

### Typing + Read
- `POST /api/channels/:channelId/typing`
- `PUT /api/channels/:channelId/read`

### Invites
- `POST /api/channels/:channelId/invites` (owner only)
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
- `CHANNEL_CREATE`
- `CHANNEL_UPDATE`
- `CHANNEL_DELETE`
- `MESSAGE_CREATE`
- `MESSAGE_UPDATE`
- `MESSAGE_DELETE`
- `TYPING_START`
- `READ_STATE_UPDATE`

READY behavior:
- includes `private_channels` (DMs)
- includes `guilds` as unavailable stubs
- followed by per-guild `GUILD_CREATE` backfill

## Data Model Notes

- Unified `channels` table:
  - `type=1` DM
  - `type=0` guild text
  - `type=4` guild category
- Guild access is enforced via `guild_members`.
- DM access is enforced via `channel_members`.
- IDs are snowflake-like values serialized as strings.
- Better Auth Drizzle mapping keys are snake_case (`auth_users`, `auth_sessions`, `auth_accounts`, `auth_verifications`).
