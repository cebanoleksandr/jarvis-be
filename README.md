# Jarvis — API

A personal AI assistant in a chat. It knows your goals and notes, works with
Google Calendar, Google Tasks and Trello, asks before changing anything, and
writes morning, evening and weekly briefings on its own schedule.

This repo is the NestJS backend. The web app lives in
[jarvis-fe](https://github.com/cebanoleksandr/jarvis-fe). In production this
service also serves the built web app (see [Deployment](#deployment)).

> "Jarvis" is a working title.

## How it works

- **Sign-in** with Google OAuth on the backend (offline access, PKCE). The
  session is a JWT in an httpOnly cookie. Google and Trello tokens are stored
  encrypted with AES-256-GCM.
- **Agent loop**: the model replies, calls tools, gets the results and
  continues. Replies stream to the browser over SSE. The model provider is
  swappable: Anthropic (default) or OpenRouter.
- **Tools** are declared once (name, zod schema, handler); the tool schema for
  the model and the argument validation both come from that declaration. The
  user id always comes from the session, never from model arguments.
  - Read freely: `get_events`, `list_tasks`, `list_trello_boards`,
    `list_trello_cards`.
  - Change only after confirmation: `create_event`, `update_event`,
    `delete_event`, `create_task`, `update_task`, `delete_task`,
    `create_trello_card`, `update_trello_card`, `archive_trello_card`,
    `comment_trello_card`.
- **Confirmations**: a changing tool call is saved as a pending action and
  shown as a card in the chat. It runs only after the user confirms. Some
  actions keep a snapshot so they can be undone.
- **Memory**: profile, goals (goal → project → task) and notes go into the
  system prompt.
- **Briefings** (morning, evening check-in, weekly review) run on BullMQ: each
  user has one delayed job per briefing, due at their next local time.
  Changing settings or time zone, or signing in, re-plans right away, and an
  hourly job re-plans every active user. Each run is recorded in Postgres, so
  a briefing is sent at most once, and lost Redis jobs are planned again.
- **Account**: full data export and deletion, Trello included.

## Stack

NestJS 12 · TypeORM + PostgreSQL · BullMQ + Redis · zod · Anthropic SDK ·
Google Calendar and Tasks APIs · Vitest · Node.js 22, native ESM

## Getting started

You need Node.js 22+ and Docker.

```bash
npm ci
cp .env.example .env              # fill in the secrets, see below
docker compose up -d postgres redis
npm run start:dev                 # http://localhost:3000/api
```

Postgres listens on host port 5435 and Redis on 6381, so they do not clash
with other local instances. Migrations run on start.

Then start the web app from
[jarvis-fe](https://github.com/cebanoleksandr/jarvis-fe) on
`http://localhost:5173`.

### Google OAuth client

In Google Cloud Console, enable the Google Calendar API and the Google Tasks
API, and create an OAuth client of type "Web application" with:

- Authorized JavaScript origin: `http://localhost:5173`
- Authorized redirect URI: `http://localhost:3000/api/auth/google/callback`

In testing mode only listed test users can sign in, and refresh tokens expire
after about 7 days.

### Trello (optional)

Create a Power-Up at
[trello.com/power-ups/admin](https://trello.com/power-ups/admin), put its API
key into `TRELLO_API_KEY` and add the web app's origin to the key's allowed
origins. Each user connects their own Trello account in settings. Without the
key, Trello is hidden.

## Environment

Validated on start (`src/config/env.validation.ts`); the app does not start
with a missing or malformed value.

| Variable               | Required | Default                  | Purpose                                                          |
| ---------------------- | -------- | ------------------------ | ---------------------------------------------------------------- |
| `DATABASE_URL`         | yes      | —                        | Postgres connection string                                       |
| `REDIS_URL`            |          | `redis://localhost:6381` | Redis for the briefing queue                                     |
| `FRONTEND_URL`         |          | `http://localhost:5173`  | Web app origin: CORS, redirects after sign-in                    |
| `GOOGLE_CLIENT_ID`     | yes      | —                        | Google OAuth client                                              |
| `GOOGLE_CLIENT_SECRET` | yes      | —                        | Google OAuth client                                              |
| `GOOGLE_CALLBACK_URL`  | yes      | —                        | `<api origin>/api/auth/google/callback`                          |
| `TOKEN_ENC_KEY`        | yes      | —                        | 32 bytes, base64 (`openssl rand -base64 32`)                     |
| `JWT_SECRET`           | yes      | —                        | At least 32 characters (`openssl rand -base64 48`)               |
| `SESSION_TTL_DAYS`     |          | `7`                      | Session length                                                   |
| `LLM_PROVIDER`         |          | `anthropic`              | `anthropic` or `openrouter`                                      |
| `ANTHROPIC_API_KEY`    | for anthropic | —                   | Anthropic API key                                                |
| `OPENROUTER_API_KEY`   | for openrouter | —                  | OpenRouter API key                                               |
| `LLM_MODEL`            |          | per provider             | `claude-opus-5-5` (anthropic) or `openrouter/free`               |
| `LLM_EFFORT`           |          | `medium`                 | `low`, `medium`, `high`, `xhigh` or `max`                        |
| `LLM_MAX_TOKENS`       |          | `64000`                  | Reply token limit                                                |
| `TRELLO_API_KEY`       |          | —                        | Enables Trello                                                   |
| `SCHEDULER_ENABLED`    |          | `true`                   | Briefings (each run costs model tokens); always off in tests     |
| `WEB_DIST`             |          | —                        | Built web app to serve (set by the Docker image)                 |
| `PORT`                 |          | `3000`                   |                                                                  |
| `DB_LOGGING`           |          | `false`                  | Log SQL                                                          |

Keep `TOKEN_ENC_KEY` once set: changing it makes stored Google and Trello
tokens unreadable, and users have to connect again.

On Render, `FRONTEND_URL` and `GOOGLE_CALLBACK_URL` default to the service's
own URL (`RENDER_EXTERNAL_URL`).

## Scripts

| Command                      | What it does                                                    |
| ---------------------------- | --------------------------------------------------------------- |
| `npm run start:dev`          | Run in watch mode                                               |
| `npm run build`              | Build into `dist/`                                              |
| `npm run start:prod`         | Run the build                                                   |
| `npm test`                   | Unit tests                                                      |
| `npm run test:e2e`           | End-to-end tests against the Postgres in `.env`; the Redis test is skipped when Redis is down |
| `npm run lint`               | oxlint, type-aware                                              |
| `npm run migration:generate -- src/database/migrations/<Name>` | Generate a migration from entity changes |
| `npm run migration:run`      | Apply migrations by hand (the app also applies them on start)   |
| `npm run migration:revert`   | Roll back the last migration                                    |

Schema changes go through migrations only; `synchronize` is off.

## Project structure

```
src/
  auth/        Google sign-in, session cookie, guards
  users/       Users, profile, schedule-change events
  google/      Google tokens, Calendar and Tasks clients and endpoints
  trello/      Trello connection, client, tools
  agent/       Agent loop, tool registry, pending actions, Calendar/Tasks tools
  llm/         Model providers (Anthropic, OpenRouter)
  chat/        Conversations, messages, streaming, search
  memory/      Goals and memory notes
  scheduler/   Briefing timing, BullMQ queue, briefing runs, settings
  account/     Data export and deletion
  health/      Health checks
  database/    TypeORM options and migrations
  config/      Environment validation
  web.ts       Serves the built web app from the same origin
test/          End-to-end tests
```

## API overview

All routes are under `/api` and need a session, except sign-in and health.

| Routes                                            | What for                                         |
| ------------------------------------------------- | ------------------------------------------------ |
| `auth/google`, `auth/google/callback`, `auth/me`, `auth/logout` | Sign-in, current user, sign-out    |
| `conversations`, `conversations/:id/messages`, `conversations/search` | Chats, streamed replies, search |
| `conversations/:id/pending-actions`, `pending-actions/:id/{confirm,cancel,undo}` | Confirmations |
| `profile`, `goals`, `memories`                    | Profile and memory                               |
| `notifications`, `notifications/:kind/run`        | Briefing schedule, run a briefing now            |
| `calendar/events`, `tasks`, `google/connection`   | Google data and connection                       |
| `trello/connection`, `trello/cards/due`, `trello/cards/:id` | Trello connection and cards            |
| `account`, `account/export`                       | Delete the account, export data                  |
| `health`, `health/live`                           | Health with and without a database check         |

## Deployment

Free setup: Render (web service) + Neon (Postgres) + an existing Render Key
Value (Redis).

One Render web service serves the API and the web app from the same origin,
so the session cookie works on `*.onrender.com` without a custom domain. The
Docker build downloads `main` of
[jarvis-fe](https://github.com/cebanoleksandr/jarvis-fe) and builds it with
`VITE_API_URL=/api`, so push the web app before deploying.

1. **Neon**: create a project (region close to Frankfurt) and copy the
   connection string (`...?sslmode=require`).
2. **Render**: New → Blueprint → this repo. `render.yaml` creates the web
   service `jarvis`. In its Environment, set `DATABASE_URL`, `REDIS_URL`
   (Internal URL of a Key Value in the same region with maxmemory policy
   `noeviction`; a workspace gets one free Key Value), `GOOGLE_CLIENT_ID`,
   `GOOGLE_CLIENT_SECRET`, `TOKEN_ENC_KEY`, `ANTHROPIC_API_KEY`, and
   optionally `TRELLO_API_KEY`, `VITE_OPERATOR_NAME`, `VITE_PRIVACY_EMAIL`.
   `JWT_SECRET` is generated.
3. **Google Cloud Console**: add the redirect URI
   `https://<service>.onrender.com/api/auth/google/callback` and the
   JavaScript origin `https://<service>.onrender.com`.
4. **Trello** (if used): add `https://<service>.onrender.com` to the API
   key's allowed origins.
5. **Keep it awake**: a free service sleeps after 15 minutes without traffic,
   and a sleeping service sends no briefings. Ping
   `https://<service>.onrender.com/api/health/live` every 10 minutes from an
   uptime monitor (cron-job.org, UptimeRobot). It does not touch the
   database, so Neon can still scale to zero. The 750 free instance hours a
   month are shared by all free services in the workspace.

A web app change does not redeploy by itself: run Manual Deploy on Render.
