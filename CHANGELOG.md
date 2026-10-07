# Changelog

All notable changes to this project are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows
[Semantic Versioning](https://semver.org/). Sections are `Added`, `Changed`, `Deprecated`, `Removed`,
`Fixed` and `Security`.

## [Unreleased]

### Added

- Pull request template in `.github/pull_request_template.md`: test plan, commit attribution, release impact, CHANGELOG gate and how to revert.
- `CONTRIBUTING.md` with setup, the gates to pass before pushing, commit attribution and contribution rules.
- `CHANGELOG.md` (this file).
- Tests with [Vitest](https://vitest.dev/): `npm test` runs `src/**/*.test.ts` without touching the database, starting with tests for cursor pagination.
- Continuous integration on GitHub Actions: `db:generate`, `typecheck`, `build` and `vitest` on every pull request and on `main`.
- People and shared expenses for splitting a cost with someone who has no Recta account: `GET/POST /people`, `PATCH/DELETE /people/:id` (people with nicknames, unique per household), `GET /people/balances`, `GET /people/:id/ledger` (cursor-paginated, with a running balance) and `GET/PUT /transactions/:transactionId/shares` plus `POST .../shares/preview` (exact, percent, shares and equal split strategies). A person with history is deactivated instead of deleted. Migration `20261005120000_add_people_and_shares` also creates the `settlements` table used by balances and the ledger.
- Settlements with a person: `GET/POST /people/:id/settlements` and `DELETE /settlements/:id`. A settlement can be only recorded, link an existing income (received) or expense (paid), or create the real transaction on an account through the transactions service.

### Changed

- `PATCH /transactions/:transactionId` now refuses (400) an amount below the shares of either direction and the change of an expense with shares into an income, and a type change on a transaction linked to a settlement.

<!-- Reference entries to their PR like this (see CONTRIBUTING.md): `... ([#123]).` and, at the bottom of this file,
     `[#123]: https://github.com/lucianodiisouza/recta-selfhosted-backend/pull/123`. -->
