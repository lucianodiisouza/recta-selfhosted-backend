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

## Importing bank statements

Two endpoints under `/transactions/import` import a bank statement in two steps. Both require authentication and EDITOR+ on the household that owns the destination account (which must be active), accept files up to 5 MB (JSON bodies up to 1 MB) and at most 1500 rows (about 25 ms of work per row, so a full import takes around 40 s; split bigger statements). Requests over the size limits answer 413.

| Endpoint | Body | Notes |
|---|---|---|
| `POST /transactions/import/preview` | multipart: `accountId`, `file` (.ofx or .csv) | Parses the file without persisting anything. Each row is flagged `duplicate` when the account already holds it. Lines that could not be read are listed in `skipped` (`line`, `reason`; `skippedCount` has the total) so nothing disappears silently. |
| `POST /transactions/import/confirm` | JSON: `{ accountId, rows: [{ date, description, amount, type }] }` | Creates the rows through the regular transaction service (balances are updated); rows already on the account are skipped. |

**Duplicates are counted, not just detected.** A row is the same transaction when type, day, amount and description match, and the file is compared to the account by occurrence: if the file has two identical coffees and the account has one, the first is a duplicate and the second is new. Identical rows with different `FITID`s in an OFX are both kept; a `FITID` repeated inside one file is skipped (`repeated-id`). Preview and confirm use the same rule, so importing the same file twice is safe. No identifier is stored with the transaction, so there is no migration; the match is on the transaction's own fields.

**Known limitation: no stored import id.** Because the match is on the transaction's own fields, a legitimate purchase that has the same type, day, amount and description as one already on the account (for example, two overlapping statements that both contain a "Coffee 10.00" on the same day, where the second one is a different purchase) shows up as a duplicate and the preview offers no override. The user can add that transaction manually. A future import reference stored with each transaction (an additive migration) would tell the two apart. The frontend sends the whole file on confirm and the server applies the same rule as the preview, so the two always agree.

**Confirm is not atomic.** Confirms on the same account run one at a time (a per-account advisory lock that is tried, not waited for), so two parallel requests cannot import the same file twice: the second one answers 409 immediately instead of queueing and holding a database connection. Each row is saved by the regular transaction service, which has its own database transaction, so a failure in the middle keeps the rows already saved: the answer then carries `stoppedAt` (index of the failing row) and `error`. Sending the same rows again continues from there, because the saved ones now count as duplicates.

**OFX.** The file is read as UTF-8 and, when it is not valid UTF-8, as Windows-1252, whatever `CHARSET` it declares (some banks declare 1252 and write UTF-8); XML entities in memos are decoded (unknown names stay as written), and only the calendar day of `DTPOSTED` is used (the time and zone are dropped), stored as that day. A credit card invoice (`CCSTMTRS`) is read like any other file but the preview answers with the `card-statement` warning: invoices have their own flow and should not be imported as a plain statement.

**CSV.** The header is optional. With a header, the date, description and amount columns are found by name (`date`/`data`, `description`/`descricao`/`historico`, `amount`/`valor`...) in any order and extra columns are ignored. Without a header (or with a three-column header that has other names) the columns are date, description and amount and a line with any other number of columns is skipped. The delimiter is `;` if the first line has one, otherwise `,`; double quotes are honoured. Dates are `dd/MM/yyyy`, `dd-MM-yyyy` or `yyyy-MM-dd`, with an optional time that is ignored. Amounts: `1.234,56` and `1,234.56` are read by the last separator; a single separator followed by one or two digits is the decimal mark; one followed by exactly three digits (`1.234`) is ambiguous and the line is skipped (`ambiguous-amount`) rather than guessed. Negative amounts (`-`, trailing `-` or parentheses) become expenses; more than two decimals are rounded to cents.

## Card invoice (OFX)

A credit card invoice (an OFX file with a `CCSTMTRS` block, as most banks export) is read by its own endpoint, because it differs from a bank statement: the same `FITID` repeats across the installments of one purchase and its discount, and the invoice month is the card's due month, not the month of the dates.

| Endpoint | Body | Notes |
|---|---|---|
| `POST /transactions/import/card-ofx/preview` | multipart: `accountId` (a credit card), `file` (.ofx, up to 5 MB and 1000 lines), `options` (optional JSON `{ "monthOverride": { "year": 2026, "month": 12 } }`) | Reads the invoice and saves nothing. Requires EDITOR+ on the card's household. |

The answer has the invoice month (`month`, `monthKey`, and `monthSource`: `statement` or `override`), the statement `period`, `ofxTotal` (purchases minus refunds and discounts, payments left out), `ledgerBalance` (the debt the file states, positive), and every `lines` entry with its `kind` (`purchase`, `refund`, `discount`, `payment`), `merchant`, `installment` (`Parcela N/M` in the memo) and `status`: `new` (no transaction holds it), `reconciled` (a transaction carries its reference, see "Source references") or `payment`. Lines that could not be read are listed in `skipped` (`position`, `reason`; the first 100, `totals.skipped` has the count) and everything the client has to word is a code: `warnings` can hold `multiple-statements`, `period-end-missing`, `card-without-due-day`, `card-without-closing-day` and `balance-mismatch`.

**Invoice month.** The statement closes on `DTEND`; it is due in the same month when the card's due day comes after its closing day (the explicit one, or due day - 7), otherwise in the next month. A card without a due day takes the closing month (`card-without-due-day`). `monthOverride` replaces the guess.

**Payment of the previous invoice.** The `Pagamento recebido` lines pay the month before the invoice's. `payment` sets them against the payments the app already counts for that invoice (tagged `invoice_pay:<card>:<year>-<month0>` and dated up to today, as in the invoice view): `state` is `matches`, `differs`, `missing`, or `undetermined` when the file has several payment lines (some may be advances). Memos such as `Parcela N/M`, `NuPay`, `Desconto Antecipação` and `Pagamento recebido` are Nubank's; any other bank's invoice still parses, as plain purchases and credits.

The preview saves nothing; it says which lines the app already holds, by reference.

Each new line also carries `possibleDuplicate` when a transaction typed by hand on the same card (no source reference, not yet linked to a line) has the same direction, the same amount in cents and a date within 3 days; a transaction is offered to one line only (lines in order, closest date first). `categorySuggestions` lists the category the household last gave each merchant of the new lines (never "other", never a deleted custom category), and the warning `possible-duplicates` appears when any line is flagged.

| Endpoint | Body | Notes |
|---|---|---|
| `POST /transactions/import/card-ofx/confirm` | JSON: `{ accountId, lines, selectedRefs, createDespiteDuplicate?, links?, categoryMap? }` | Creates the selected lines as transactions on the card (paid, with the line's memo as description and its `ofx:` ref as `source_ref`; an installment line also gets its plan id, number and total). Requires EDITOR+ on the card household. |

**Idempotent, and checked for consistency.** `lines` are the preview lines in order, echoed back; each is checked against its own content (its ref must be the one derived from its fitid, memo, amount and date, with identical lines numbered in file order; its kind, merchant and installment must follow from its memo; no NUL characters), and a mismatch is a 400. That proves a line is consistent with itself, **not that it came from a file**: the ref format is public and is not a signature, so a caller can do no more than an editor creating the transaction by hand. What is new is decided on fresh data: a line whose ref a transaction already carries or represents is skipped (`already-imported`), whoever imported it, and `source_ref` is unique per household, so parallel confirms cannot create a line twice. **One confirm per card runs at a time:** a second one answers 409 at once instead of waiting (a wait would hold a database connection per waiting request, and the pool has 10); the guard is per process, and across processes the unique ref keeps lines from being created twice. Rows are not atomic (each is created by the regular transaction service); if one fails after others were saved the answer carries `stoppedAt` and sending the same request again continues. Payment lines are refused (a 400), and so is a category that does not fit the line's direction or a custom one (`CUSTOM:<uuid>`) that is not in the household.

**Transactions typed by hand.** A selected line that still has a `possibleDuplicate` is skipped (`possible-duplicate`) unless its ref is in `createDespiteDuplicate`. `links: [{ ref, transactionId }]` records the line as represented by that transaction instead of creating one (`transaction_external_refs`): the server only accepts the transaction it offers for that line now, rechecks it under a row lock (same card, no ref, same direction and amount, not linked yet) and answers `link-refused` otherwise. A linked line shows as `reconciled` from then on. Smarter matching (amounts that differ, several rows for one purchase, other months) is not part of this step.

Payment lines, future installments of a plan and adjusting the previous invoice payment are not written by this step.

UTF-8, windows-1252 and UTF-16 (with a byte order mark) files are read; `CDATA` sections in memos and ids are supported.
## Transaction write hooks (internal)

Code that writes transactions together with rows of its own (an importer recording the external lines a transaction represents, for example) needs those writes to commit or roll back with the transaction and its balance effect. The transaction service exposes hooks for that; none of them is reachable over HTTP.

| Function | Hook | Runs | Throwing |
|---|---|---|---|
| `createTransaction(input, userId, hooks)` | `hooks.inTransaction(tx, created)` | after the row and its balance effect were written | rolls the whole create back |
| `updateTransaction(id, household, input, options)` | `options.beforeWrite(tx)` | after the row is locked and read again, before any balance is touched | nothing is written |
| | `options.inTransaction(tx)` | after the row was written | rolls the update back |
| `deleteTransaction(id, household, options)` | `options.guard(tx)` | after the row is locked and read again, before anything is written, for any delete except the three paid cases below (a plain income or expense, paid or not; an unpaid transfer, allocation or split expense; a paid row with no account or category) | nothing is deleted |

`guard` does **not** run for a **paid** transfer, a **paid** allocation or a **paid** split expense, which have their own delete paths.

`sourceRef` is accepted by `createTransaction` and `updateTransaction` as a server-side field (`InternalCreateTransactionInput`, `InternalUpdateTransactionInput`); it is not in the HTTP schemas, so a client cannot set it. `guard` does not run for a paid transfer, a paid allocation or a paid split expense, which have their own delete paths.

**Locks, in one order.** `updateTransaction` and `deleteTransaction` both lock the transaction row first (`SELECT ... FOR UPDATE`), read it again, and only then the accounts it touches (several accounts are always locked by id). Because both take their locks in the same order, an update and a delete of the same row, or two moves that cross, wait for each other instead of deadlocking.

**Conflicts and retries.** If someone changed the account, amount or type that the request itself sets, `updateTransaction` answers 409. Any other concurrent change makes the call read the row again and go on, and a Postgres deadlock (SQLSTATE 40P01) is also retried; each call tries up to 3 times, then answers 409. A delete whose row changed between its read and its lock is retried the same way (404 if the row is gone). **The hooks run on every attempt**, each inside a fresh database transaction, so a hook must be safe to run more than once.

**Who uses them.** `inTransaction` on create and `beforeWrite`/`inTransaction` on update are what the card invoice import (record the external refs together with the row) and the review queue (move or delete rows, claiming them first) need; `guard` is for callers that must recheck something atomically with a delete (shares, settlements).

## Source references

`transactions.source_ref` (up to 120 characters, nullable, unique per household) and the `transaction_external_refs` table (a `ref` per household, pointing at the transaction that represents it) hold the identity of the external line a transaction came from. They make a re-import recognize what it already holds. Manual transactions have no `source_ref`.

The prefix names the importer and is a public contract: refs are written once and never rewritten, so the layout of a ref must not change.

| Prefix | Layout | Written by |
|---|---|---|
| `ofx:` | `ofx:<FITID>:<8 hex>` | The card invoice OFX import. `<FITID>` is the statement's id as is when it is short and made of `A-Za-z0-9._-`, otherwise `h` + 32 hex of its sha1; the 8 hex are the start of sha1 of `memo|signed amount|date` (two identical lines of one file add `|#2`, `|#3`... to the hashed text, in file order), which tells apart the installments of one purchase that share a `FITID`. |

A new importer picks its own prefix and must not write refs under `ofx:`.

**Limit: a ref is unique per household, not per card.** Two cards of the same household with a line of the same FITID, memo, amount and date (which a bank does not issue: FITIDs are unique per statement) would share a ref, and the second would be skipped as already imported. The ref is not scoped by card because that would change the public `ofx:` layout; if it ever matters, a new prefix is the way.

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
