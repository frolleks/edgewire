# Discord Clone (1:1 DM)

Minimal Discord-like 1:1 direct-message clone with:
- `apps/web`: React + TypeScript + Tailwind + shadcn/ui + React Router + React Query
- `apps/server`: Bun REST API + Bun WebSocket Gateway subset
- PostgreSQL + Drizzle ORM migrations
- Better Auth (email/password + secure-cookie sessions)

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

## 5) Auth + DB Schema Generation

Generate Better Auth schema file (already committed in this repo, but command kept for workflow):

```bash
bun run auth:generate
```

Generate Drizzle migration SQL:

```bash
bun run db:generate
```

Apply migrations:

```bash
bun run db:migrate
```

If you previously used `discord_clone` for a different project and see errors like `relation "auth_users" does not exist` or `relation ... already exists`, point `DATABASE_URL` to a clean DB (default is `discord_clone_dm`) and re-run migrations.

(Optional) open Drizzle Studio:

```bash
bun run db:studio
```

## 6) Run in Development

Single command (starts both server + web):

```bash
bun run dev
```

Or run in separate terminals:

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

Build all apps:

```bash
bun run build
```

Start backend:

```bash
bun run start:server
```

(Optional) start web static server:

```bash
bun run start:web
```

## API/Gateway Subset Implemented

### REST

- `GET /api/users/@me`
- `PUT /api/users/@me/profile`
- `GET /api/users?q=...`
- `GET /api/users/@me/channels`
- `POST /api/users/@me/channels`
- `GET /api/channels/:channelId/messages?limit=50&before=:messageId`
- `POST /api/channels/:channelId/messages`
- `PATCH /api/channels/:channelId/messages/:messageId`
- `DELETE /api/channels/:channelId/messages/:messageId`
- `POST /api/channels/:channelId/typing`
- `PUT /api/channels/:channelId/read`
- `POST /api/gateway/token`
- Better Auth mounted on `GET/POST /api/auth/*`

### Gateway

- Endpoint: `/gateway` (also accepts `/api/gateway`)
- Supported opcodes: `10 HELLO`, `1 HEARTBEAT`, `11 HEARTBEAT_ACK`, `2 IDENTIFY`, `6 RESUME`, `9 INVALID_SESSION`, `0 DISPATCH`
- Dispatch events: `READY`, `CHANNEL_CREATE`, `MESSAGE_CREATE`, `MESSAGE_UPDATE`, `MESSAGE_DELETE`, `TYPING_START`, `READ_STATE_UPDATE`

## Notes

- Message IDs and channel IDs are snowflake-like `bigint` values in PostgreSQL and serialized as strings in API/Gateway payloads.
- CORS is configured for `APP_ORIGIN` and credentials are enabled for cookie sessions.
- WebSocket authorization uses short-lived gateway tokens minted via `POST /api/gateway/token`.
