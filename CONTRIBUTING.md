# Contributing to Recta (backend)

Thanks for wanting to contribute. This guide covers how to set up the project, which checks must pass
before you push, and the rules reviewers apply. The README explains what the project is; this file explains
how to change it.

## Dev setup

```bash
git clone https://github.com/lucianodiisouza/recta-selfhosted-backend
cd recta-selfhosted-backend
npm ci
cp env.example .env     # fill in DATABASE_URL and the Firebase credentials
npm run db:generate     # generates the Prisma Client in src/generated
npm run dev
```

Requirements: Node.js 20.19 or newer, or 22.12 or newer (the same as the frontend, which Vite 7 requires; CI tests 20.19 and 22), and PostgreSQL. Unit tests do **not** need a database:
`vitest.config.ts` injects a dummy `DATABASE_URL`, because importing any service loads
`shared/db/prisma.ts`, which exits the process when the variable is missing. If your shell already defines
`DATABASE_URL` it is respected (`src/shared/config/env.test.ts` covers the validation that makes the dummy necessary); never point the tests at a database that holds real data.

## Commit attribution

GitHub associates commits with accounts through the author e-mail stored in each commit. Before pushing a
branch, inspect every commit that the pull request will add:

```bash
git log --format='%h %an <%ae>' "$(git merge-base HEAD origin/main)"..HEAD
```

Use an e-mail verified by your GitHub account, or its GitHub-provided `noreply` address. Set it for this
checkout when your global Git identity belongs to a different project or employer:

```bash
git config --local user.name "Your Name"
git config --local user.email "your-verified-address@example.com"
```

Correct attribution mistakes on the pull-request branch before it is merged. The project does not rewrite
shared `main` history or published release tags solely to change attribution, because doing so invalidates
commit hashes and breaks existing clones and forks.

## Required gates before push/merge

All of these must pass; CI (`.github/workflows/ci.yml`) runs the same steps on every pull request.

```bash
npm ci
npm run db:generate    # typecheck depends on the generated Prisma Client
npm run typecheck      # tsc --noEmit
npm run build
npm test               # vitest run
git diff --check
```

The statement import also has a test against a real Postgres (`src/modules/transactions/import.integration.test.ts`). It is skipped
unless `IMPORT_DB_TEST_URL` points at a scratch database that already has the migrations: create it, run
`DATABASE_URL=<url> npx prisma migrate deploy`, then `IMPORT_DB_TEST_URL=<url> npx vitest run src/modules/transactions/import.integration.test.ts`.
CI runs it in the `integration` job against a Postgres service. Never point it at a database that holds real data.

`npx vitest run path/to/file.test.ts` runs a single file; `npx vitest` starts watch mode. If you changed
`prisma/schema.prisma` or added a migration, see "Migrations" below.

## Contribution rules

1. **One PR = one feature (or fix) that can be reverted on its own.** If `git revert` of the PR leaves a
   project that no longer compiles or passes its tests, the PR is too large or too coupled. Prefer small
   PRs in sequence over one PR that mixes topics.
2. **No dead code and no half-built features.** Do not leave unused functions, unreachable branches,
   ownerless `TODO`s or commented-out code. Deferred work goes in an issue.
3. **Comments explain why, never what.** Do not comment what the next line already says. Comment the
   constraint, the edge case or the bug that justifies the code.
4. **Write tests before claiming done.** Write the test, watch it fail, then make it pass. This matters
   most for parsers, balance and date calculations, permission rules and anything that touches money. A
   bug-fix test must fail without the fix. Tests live next to the code (`src/**/*.test.ts`), use synthetic
   values and **never** real data (statements, names, e-mails).
5. **Do not refactor outside the scope.** Touch only what the PR requires. Refactoring is another PR.
6. **Migrations are additive only.** New columns are nullable or have a default, new tables do not change
   existing ones, and no migration drops or renames data. Never rename or edit a published migration.
7. **Commits in English, Conventional Commits style** (`feat(scope): ...`, `fix(scope): ...`,
   `chore: ...`, `docs: ...`, `test: ...`, `refactor: ...`). Messages explain the why when it is not obvious.
8. **The CHANGELOG is a merge gate** (next section).

### Migrations

- Generate the migration with `npm run db:migrate` and read the generated SQL. Prisma sometimes includes
  drift fixes unrelated to your PR; remove them or justify them in the PR.
- Apply the whole set to an **empty, disposable** database (`DATABASE_URL` pointing at it, then
  `npm run db:deploy`) and confirm the schema matches `schema.prisma`:
  `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code`
  exits 0 (empty diff). Never run this against a database with real data.
- `git revert` of a PR with a migration removes the folder from the repository but **does not undo what
  the database already applied**. That is why migrations must be additive: with the column or table
  ignored, the application keeps working. Say in "How to revert" what is left in the database.

## The CHANGELOG is a merge gate

Every change that is **visible to users or to whoever self-hosts** must add an entry to `CHANGELOG.md`
under `## [Unreleased]` in the same PR. That includes: a new route or field, an environment variable, a
migration, any changed behaviour or default, and any observable bug fix. Internal refactors, dead-code
removal and test-only churn are exempt.

Reviewers treat a missing entry as **blocking**; the PR template has a checkbox for it. Write one
past-tense sentence and place it under the right heading (`### Added`, `### Changed`, `### Fixed`, ...).
After opening the PR, append its number to the entry as a reference-style link and define the link at the
bottom of `CHANGELOG.md`:

```markdown
- Added the `POST /accounts/:id/adjust-balance` route ([#123]).

[#123]: https://github.com/lucianodiisouza/recta-selfhosted-backend/pull/123
```

## Versioning and deprecation policy

This project follows [Semantic Versioning](https://semver.org/):

- **Patch** (`x.y.Z`): bug fixes that do not change the public API or the data format.
- **Minor** (`x.Y.0`): additive changes (route, optional field, environment variable, additive
  migration). Existing behaviour is preserved.
- **Major** (`X.0.0`): breaking changes, including a data format change without a migration, a removed
  route or field, or a contract change that breaks existing clients.

Put your CHANGELOG entry under the heading that matches its semver impact: a fix filed under `Added` (or
vice versa) can make the maintainer pick the wrong version. Do not change the `version` field of
`package.json` in a PR (the root `version` recorded in `package-lock.json` follows it; if npm rewrites it, commit
that on its own as `chore(deps): sync lockfile root version`); whoever cuts the release decides the version. If your change is breaking, say so in
the PR description and check "Major" in the template.

Deprecated items go under `### Deprecated` in the CHANGELOG and are removed no sooner than the following
major release.
