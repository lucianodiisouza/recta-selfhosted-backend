# Recta Backend

Backend for Recta — personal finance app with household collaboration. **Open source & self-hostable.**

## About this project

Recta is an open source personal finance manager. This repository is the public backend: **anyone can self-host it**, fork it, submit pull requests, or build on top of it. Submitting PRs or contributing does **not** guarantee that any feature or change will be incorporated into the hosted product at [recta.app](https://recta.app). The maintainers decide what is merged and what is shipped on recta.app.

This project is maintained by [PrimoDev](https://www.oprimo.dev).

**Other part of the project:** [recta-selfhosted-frontend](https://github.com/oprimodev/recta-selfhosted-frontend) — web app (React/Vite).

## Tech stack

- **Node.js** 20.19+ (or 22.12+)
- **Fastify** – REST API
- **PostgreSQL** – database
- **Prisma** – ORM
- **Firebase Admin** – auth (Google, Apple, email)
- **Zod** – validation

## Hosting (self-hosted)

You can run this backend on any Node.js host. Some options:

- **[Railway](https://railway.app)** – simple deploy, PostgreSQL add-on, cron support
- **[Render](https://render.com)** – free tier, PostgreSQL, background workers
- **[Fly.io](https://fly.io)** – global regions, PostgreSQL via Supabase or external
- **[DigitalOcean App Platform](https://www.digitalocean.com/products/app-platform)** – managed app + DB
- **VPS** (Hetzner, Linode, etc.) – run `npm run start` behind Nginx and use a managed PostgreSQL (e.g. Supabase, Neon, or self-hosted)

Set `DATABASE_URL`, pick an [auth mode](#auth-mode) and, in production, `ALLOWED_ORIGINS` and optionally `SWAGGER_USERNAME`/`SWAGGER_PASSWORD`. For recurring transactions, schedule `npm run cron:process-recurrences` once per day (cron job or Railway cron).

You don't need Firebase to run a working instance — `local` auth mode plus PostgreSQL is enough.

## How to run

### Prerequisites

- Node.js 20.19+ (or 22.12+)
- PostgreSQL 16+
- Firebase project with Authentication enabled

### 1. Install dependencies

```bash
npm install
```

### 2. Environment variables

```bash
cp env.example .env
```

Edit `.env`:

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL URL, e.g. `postgresql://user:password@localhost:5432/recta` |
| `AUTH_MODE` | Yes | `local` (no Firebase) or `firebase` (default). See below. |

#### Auth mode

Choose how users sign in via `AUTH_MODE`:

- **`local`** (recommended for self-host) — no third-party auth. The backend issues and verifies its
  own JWTs for email/password login. Requires `AUTH_JWT_SECRET` (min 32 chars; generate with
  `openssl rand -base64 48`). Optional: `AUTH_TOKEN_TTL_HOURS` (default 720 = 30 days),
  `AUTH_REQUIRE_EMAIL_VERIFICATION` (default `false`). No Firebase setup needed.
- **`firebase`** (default) — Google/Apple/Email sign-in via Firebase. Provide credentials with one of
  the two options below. Optionally set the public `AUTH_FIREBASE_WEB_API_KEY` so `GET /auth/config`
  hands the client your web config.

Clients call `GET /auth/config` (public) to discover the mode before showing a login screen.

**Firebase – option A (file):**

- Create a [service account](https://console.firebase.google.com/project/_/settings/serviceaccounts/adminsdk) and download the JSON.
- Save it in the project (e.g. `firebase-service-account.json`) and **do not commit** it.
- In `.env`: `GOOGLE_APPLICATION_CREDENTIALS=./firebase-service-account.json`

**Firebase – option B (env vars):**

- In `.env` set: `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` (private key with `\n` for newlines).

Other optional vars: `PORT` (default 3000), `REDIS_URL`, `SWAGGER_USERNAME`/`SWAGGER_PASSWORD`, `ALLOWED_ORIGINS`, `FIRST_RUN`. See `env.example`.

> In production use `npm run db:deploy` (not `db:migrate`) to apply migrations, or set `FIRST_RUN=true` on the first boot to run them automatically, then remove it.

### 3. Run migrations

```bash
npm run db:migrate
```

### 4. Start the server

**Development:**

```bash
npm run dev
```

**Production:**

```bash
npm run build
npm run start
```

API at `http://localhost:3000`. Swagger docs (when enabled): `http://localhost:3000/docs`.

### 5. Verify

```bash
curl http://localhost:3000/health
```

Returns `{ status, timestamp, uptime, apiVersion, minClientVersion }`. `apiVersion` is the self-host
contract: clients compare it against the official contract to detect a backend that has fallen behind.
If your instance reports an older `apiVersion` than the app expects, pull the latest code and redeploy
so the schema and endpoints stay in sync.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Production build |
| `npm run start` | Run production build |
| `npm run db:migrate` | Run migrations (dev) |
| `npm run db:deploy` | Run migrations (production) |
| `npm run db:studio` | Open Prisma Studio |
| `npm run db:generate` | Generate Prisma Client |
| `npm run lint` | Lint |
| `npm run typecheck` | Type check |
| `npm test` | Unit tests (Vitest, no database needed) |

## Recurring transactions (cron)

To process recurring transactions daily, run as a cron job:

```bash
npm run build
npm run cron:process-recurrences
```

Schedule this once per day (cron, systemd, or your host’s scheduler).

## Transaction write hooks (internal)

Code that writes transactions together with rows of its own (an importer recording the external lines a transaction represents, for example) needs those writes to commit or roll back with the transaction and its balance effect. The transaction service exposes hooks for that; none of them is reachable over HTTP.

| Function | Hook | Runs | Throwing |
|---|---|---|---|
| `createTransaction(input, userId, hooks)` | `hooks.inTransaction(tx, created)` | after the row and its balance effect were written | rolls the whole create back |
| `updateTransaction(id, household, input, options)` | `options.beforeWrite(tx)` | after the row is locked and read again, before any balance is touched | nothing is written |
| | `options.inTransaction(tx)` | after the row was written | rolls the update back |
| `deleteTransaction(id, household, options)` | `options.guard(tx)` | after the row is locked and read again, before anything is written, for any delete except the three paid cases below (a plain income or expense, paid or not; an unpaid transfer, allocation or split expense; a paid row with no account or category) | nothing is deleted |

`guard` does **not** run for a **paid** transfer, a **paid** allocation or a **paid** split expense, which have their own delete paths.

**Locks, in one order.** `updateTransaction` and `deleteTransaction` both lock the transaction row first (`SELECT ... FOR UPDATE`), read it again, and only then the accounts it touches (several accounts are always locked by id). Because both take their locks in the same order, an update and a delete of the same row, or two moves that cross, wait for each other instead of deadlocking.

**Conflicts and retries.** If someone changed the account, amount or type that the request itself sets, `updateTransaction` answers 409. Any other concurrent change makes the call read the row again and go on, and a Postgres deadlock (SQLSTATE 40P01) is also retried; each call tries up to 3 times, then answers 409. A delete whose row changed between its read and its lock is retried the same way (404 if the row is gone). **The hooks run on every attempt**, each inside a fresh database transaction, so a hook must be safe to run more than once.

**Who uses them.** `inTransaction` on create and `beforeWrite`/`inTransaction` on update are what the card invoice import (record the external refs together with the row) and the review queue (move or delete rows, claiming them first) need; `guard` is for callers that must recheck something atomically with a delete (shares, settlements).

## Project structure

```
src/
├── app.ts              # Fastify app
├── index.ts            # Entry point
├── modules/            # API modules (auth, users, households, accounts, transactions, etc.)
├── shared/
│   ├── config/         # env, Firebase
│   ├── db/             # Prisma & migrations
│   ├── middleware/     # Auth & authorization
│   └── utils/
└── jobs/               # Cron (e.g. processRecurrences)
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the checks that must pass before a push, and the pull request rules. User-facing changes are recorded in [CHANGELOG.md](CHANGELOG.md).

## License

MIT
