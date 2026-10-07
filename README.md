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

A monthly recurrence has at most one occurrence per month: executing it (cron, `POST /recurring-transactions/:id/execute`, or right after creating or editing it) only moves `nextRunAt` on when a transaction of that recurrence already exists in the month (for example one linked by the detector). Weekly, biweekly and daily recurrences are not affected.

### Detecting recurring expenses

`POST /recurring-transactions/detect` (any household member) reads the household's expense history and proposes monthly recurrences; `POST /recurring-transactions/detect/apply` (EDITOR+) creates the ones the user picks. Bodies: `{ householdId, minMonths?, months? }` (defaults 3 and 12; `minMonths` 2-12, `months` 3-36, `minMonths <= months`) and `{ householdId, minMonths?, months?, items: [{ id, amount?, dayOfMonth?, description?, followLastAmount? }] }` (1-300 items).

- Only paid, non-installment expenses in the window count. Income, unpaid rows, future-dated rows, installments, invoice payments and what an active recurrence already covers (same account and normalized description, or already linked to it) are left out; `skipped` counts what was left out by reason (`alreadyRecurring`, `installments`, `sparse`, `consumption`).
- Groups are keyed by account + normalized description (accents, case, `N/M` tokens, loose numbers and punctuation dropped). A candidate needs `minMonths` distinct months, month coverage of at least 50% between its first and last month, and a last paid month no older than the previous month.
- `kind: 'stable'`: at least 80% of the monthly values within `max(0.50, 10%)` of the median, and not several charges per month (consumption such as fuel or bakery stays out). `kind: 'bill'`: at least 3 months and a most frequent category that is a system `UTILITIES` or `HOUSING`; bills enter whatever their variation.
- `amount` is the latest real value, `medianAmount`/`minAmount`/`maxAmount` summarise the window, `dayOfMonth` is the most common day, `defaultSelected` means 3+ months and no gap of two or more months, `followLastAmount` is true by default. Ids are deterministic (account + normalized description).
- Apply recomputes everything on the server inside one database transaction under a per-household lock: ids that no longer exist count as `skipped` (so repeating a call creates nothing), each chosen candidate becomes a MONTHLY recurrence starting at the first month after its last paid one that has no expense of the group yet (on its day, clamped to the month length), and the historical transactions are linked to it (`recurringTransactionId`) without touching any balance. Anything it declined to do comes back in `warnings` as `{ code, description, dayOfMonth? }` (`duplicate-in-call`, `already-active`, `short-month-day`) for the client to translate.

### Following the last real value

A recurrence with `followLastAmount: true` predicts the next value as the last real one. When `PATCH /transactions/:id` changes the amount of the most recent occurrence of such an active recurrence (largest date, not beyond today + 31 days), the recurrence `amount` is updated in the same database transaction and the response carries `recurringUpdated: { id, amount }`. Editing or paying an older occurrence never changes the recurrence. `GET /recurring-transactions` items carry `lastOccurrenceDate` (latest occurrence up to today + 31 days). `followLastAmount` is accepted by `POST` and `PATCH /recurring-transactions` and returned with every recurrence.

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
