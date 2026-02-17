# AGENTS.md

## Purpose
This repository is a minimal Discord-like 1:1 DM clone with a Bun backend and React frontend.

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
- DB default: `postgres://postgres:postgres@localhost:5432/discord_clone_dm`
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
- Gateway endpoint is `/gateway` (also `/api/gateway`).
- Gateway token is minted via `POST /api/gateway/token`.
- Snowflake-like IDs are stored as `bigint` and serialized as strings in API payloads.

## Frontend Notes
- Routes:
  - `/login`
  - `/register`
  - `/app`
  - `/app/channels/:channelId`
- WebSocket flow follows HELLO -> HEARTBEAT loop -> IDENTIFY.
- Gateway dispatch events update React Query caches.

## Drizzle/Better Auth Schema Mapping
- Better Auth `modelName` values are snake_case table names.
- Drizzle adapter schema keys in `apps/server/src/auth.ts` must match those model names exactly:
  - `auth_users`, `auth_sessions`, `auth_accounts`, `auth_verifications`
- Do not reintroduce Better Auth `fields` remapping for Drizzle models unless fully validated.

## UI/Theming Constraint
- In `apps/web/src/App.tsx`, avoid custom text/background color overrides unless explicitly requested.
- Prefer theme tokens (`bg-background`, `bg-card`, `bg-accent`, etc.) and component defaults.
