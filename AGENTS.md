# AGENTS.md

## Purpose

This repository is a chat app with a Bun backend and React frontend.

## Stack

- Frontend: React + TypeScript + TailwindCSS + shadcn/ui + React Router + React Query
- Backend: Bun (`Bun.serve`) REST + WebSocket gateway subset
- Database: PostgreSQL + Drizzle ORM + Drizzle Kit
- Auth: Better Auth (cookie sessions)

## Monorepo Layout

- `apps/web` - frontend app
- `apps/server` - API + gateway + auth + db schema
- `packages/types` - shared protocol/types

## Important Environment Defaults

- Server env file: `apps/server/.env`
- DB default: `postgres://postgres:postgres@localhost:5432/edgewire_dm`
- Web default API base: `http://localhost:3001`

## Common Commands (run from repo root)

- Install deps: `bun install`
- Start Postgres: `docker compose up -d`
- Generate migrations: `bun run db:generate`
- Apply migrations: `bun run db:migrate`
- Run dev (web + server): `bun run dev`
- Run server only: `bun run dev:server`
- Run web only: `bun run dev:web`
- Build all: `bun run build`

## Backend Notes

- Better Auth is mounted at `/api/auth/*`.
- REST routing uses Bun's built-in `routes` map (`apps/server/src/routes.ts`) mounted from `apps/server/src/index.ts`.
- Route handlers are split by domain in `apps/server/src/controllers/*`.
- Shared HTTP helpers for CORS/preflight/JSON/auth guards live in `apps/server/src/http/index.ts`.
- Shared server runtime/business logic used by controllers + gateway lives in `apps/server/src/runtime.ts`.
- Permissions use bitfields stored as strings and evaluated via BigInt (`apps/server/src/lib/permissions.ts` + `apps/server/src/lib/permission-service.ts`).
- Guild role + member-role + channel-overwrite persistence is in:
  - `guild_roles`
  - `guild_member_roles`
  - `channel_permission_overwrites`
- `@everyone` role is created automatically for each guild with `role.id === guild.id`.
- New REST surface includes guild settings patch, role CRUD/reorder, member role assignment, channel overwrite edit/delete, and bulk channel reorder.
- `fetch(req, server)` in `apps/server/src/index.ts` is reserved for WebSocket upgrades (`/gateway`, `/api/gateway`) and non-route fallbacks.
- Gateway endpoint is `/gateway` (also `/api/gateway`).
- Gateway token is minted via `POST /api/gateway/token`.
- Snowflake-like IDs are stored as `bigint` and serialized as strings in API payloads.

## Frontend Notes

- Routes:
  - `/login`
  - `/register`
  - `/app`
  - `/app/channels/@me`
  - `/app/channels/@me/:channelId`
  - `/app/channels/:guildId`
  - `/app/channels/:guildId/:channelId`
- WebSocket flow follows HELLO -> HEARTBEAT loop -> IDENTIFY.
- Gateway dispatch events update React Query caches.
- Guild channel sidebar uses `dnd-kit` (`apps/web/src/components/guild-channel-tree.tsx`) for category/channel reorder and parent moves.
- Server settings UI is in `apps/web/src/components/guild-settings-modal.tsx` (Overview, Roles, Members).
- Permission-aware frontend helpers live in `apps/web/src/lib/permissions.ts`.

## Drizzle/Better Auth Schema Mapping

- Better Auth `modelName` values are snake_case table names.
- Drizzle adapter schema keys in `apps/server/src/auth.ts` must match those model names exactly:
  - `auth_users`, `auth_sessions`, `auth_accounts`, `auth_verifications`
- Do not reintroduce Better Auth `fields` remapping for Drizzle models unless fully validated.

## UI/Theming Constraint

- In `apps/web/src/App.tsx`, avoid custom text/background color overrides unless explicitly requested.
- Prefer theme tokens (`bg-background`, `bg-card`, `bg-accent`, etc.) and component defaults.
