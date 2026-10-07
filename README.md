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

## People and shared expenses

Splitting an expense with someone who has no Recta account: you pay 100%, a person owes you their part, and later they pay you back (or you pay them). This is **not** the household split (`isSplit` / `TransactionSplit`), which needs the other person to be a user and debits their part from their own account: nothing here moves money between accounts.

Everything is scoped to a household. Reading needs membership, writing needs EDITOR+, and the household is authorized before any error that depends on data (404, 409, a rejected split). Amounts are reais with two decimals, computed on integer cents. **Single currency:** shares, settlements and balances are plain amounts, with no currency; a household that mixes accounts in different currencies gets sums of unlike amounts. Responses are wrapped as `{ success, data }` (the ledger adds `pagination`). Routes keyed by an id alone (`/people/:id`, `/transactions/:transactionId/shares`) read the household from the record; an optional `?householdId=` query is authorized first and scopes the lookup, and a caller who is not in the record's household gets the same 404 as for an id that does not exist.

| Endpoint | Notes |
|---|---|
| `GET /people?householdId&includeInactive` | People with their aliases. |
| `POST /people` `{ householdId, name, aliases? }` | 201. Names and aliases are unique per household after normalization (lower case, no accents, single spaces), across people: a repeat is a **409**. At most 20 aliases of 100 characters and 500 people per household; a name that is empty once normalized, or longer than 100 characters once normalized, is a 400. |
| `PATCH /people/:id` `{ name?, aliases?, isActive? }` | `aliases` replaces the list. A rename keeps the old name as an alias (a person keeps at most 20: the oldest are dropped). |
| `DELETE /people/:id` | 204 for a person with no data (the person row is locked while counting, so a share committed meanwhile is never cascaded away); a person with shares or settlements is only deactivated and answered with 200 and the person. |
| `GET /people/balances?householdId` | Per person: `owedToMe`, `iOwe`, `received`, `paid`, `balance = owedToMe - iOwe - received + paid` (positive: they owe you), `openShares`. Inactive people only while their balance is not zero. |
| `GET /people/:id/ledger?householdId&limit&cursor&order` | Shares and settlements with `signed` and a running `balanceAfter`, computed over the whole history in chronological order (day, creation time, id) and then paged with a cursor. Newest first by default (`order=asc` flips the list, not the balances); `limit` 1..200, default 50. The cursor is opaque; a malformed one is a 400. |
| `GET /transactions/:transactionId/shares` | The shares and `myPart` (amount minus what people owe me). |
| `PUT /transactions/:transactionId/shares` `{ direction, strategy, entries, myShares? }` | Replaces the shares **of that direction** (`THEY_OWE_ME` or `I_OWE_THEM`) in one database transaction; no entries removes them. Only income and expense transactions; the people must be active and of the household. |
| `POST /transactions/:transactionId/shares/preview` | Same body, computes without saving: `{ shares: [{ personId, amount }], myPart }`. |
| `GET /people/:id/settlements`, `POST /people/:id/settlements` | See below. |
| `DELETE /settlements/:id` | 204. Never deletes the transaction. |

**Split strategies** are shortcuts to type a split; what is stored is always an amount per person. `exact`: each entry has its `amount`. `percent`: each entry has its `percent` of the transaction total (two decimals; what is left stays with me). `shares`: each entry has its `shares` (whole cotas), mine are `myShares` (default 1). `equal`: the people listed and I split evenly. Cents left by a division go to the first person listed, so the parts and my part always add up to the transaction amount. Every part is at least 0.01, nobody is listed twice, the parts of a direction never exceed the transaction amount, and at most 50 people.

`PATCH /transactions/:id` (the user-facing update, not the internal service) answers 400 when the new amount (compared with its sign) is below the sum of the shares of either direction, or when an expense with shares would become an income: reduce or remove the shares first. `PUT` shares and that update are serialized per transaction by a database advisory lock (taken before the row lock that `PUT` also takes), so shares can never end up above the amount; the update waits for a `PUT` in progress and the other way round.

Deleting a transaction deletes its shares (cascade); a settlement that points to it only loses the link. `people.user_id` (a person that is also a Recta user) and `transaction_shares.source` (`manual`, or `import` for shares created by a later importer) are in the migration but not used by these routes yet: they are kept so the table matches the migration the fork already applied.

**Database connections:** besides the main pool (up to 10 connections per instance), the lock that serializes an amount update and the shares of the same transaction uses its own pool of up to 10, so an instance can hold up to 20; a small database plan (for example one with a 20 or 25 connection limit) should be sized for that. A request that cannot get a lock connection within 10 seconds fails instead of waiting.

**Settlements** record money that changed hands: `RECEIVED` (they paid me) or `PAID` (I paid them), with an amount, a day and a note. Three ways: only the record; `transactionId`, linking an existing transaction (an income for `RECEIVED`, an expense for `PAID`) that no other settlement uses (409 otherwise; the transaction is locked, with the same lock the guarded update takes, while its type and link are checked, so a type change that coincides with the link cannot slip between them); or `createTransaction: { accountId, description?, categoryName? }`, which creates the real transaction through the regular transaction service, so the account balance moves like for any transaction, and links it. If the settlement cannot be saved after the transaction was created, the transaction is removed again. Deleting a settlement keeps its transaction; deleting a transaction unlinks its settlement and removes its shares. `PATCH /transactions/:id` also answers 400 when the type would change on a transaction linked to a settlement (`RECEIVED` must stay an income, `PAID` an expense): delete the settlement first.

The migration `20261005120000_add_people_and_shares` creates the `settlements` table together with the people tables. To undo it (people, shares and settlements are lost): `DROP TABLE settlements, transaction_shares, person_aliases, people; DROP TYPE "SettlementDirection", "ShareDirection";`, delete the folder and, if it was applied through Prisma, `npx prisma migrate resolve --rolled-back 20261005120000_add_people_and_shares`.

## Project structure

```
src/
├── app.ts              # Fastify app
├── index.ts            # Entry point
├── modules/            # API modules (auth, users, households, accounts, transactions, people, etc.)
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
