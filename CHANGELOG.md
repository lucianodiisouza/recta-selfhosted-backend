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

### Changed

- Updating or deleting a transaction locks its row and reads it again, taking the row first and then the accounts, in the same order in both. If someone else changed the account, amount or type that an update was itself changing, it now answers 409 ("changed by someone else; reload and try again") instead of applying the update on stale balances; other concurrent changes are applied on top, and a Postgres deadlock is retried up to 3 times before answering 409. A delete whose row changed meanwhile is retried too.
- Internal hooks in the transaction service (an in-transaction hook on create, a before-write and an in-transaction hook on update, a guard on delete) for importers, documented in the README ("Transaction write hooks"). Not reachable over HTTP.

<!-- Reference entries to their PR like this (see CONTRIBUTING.md): `... ([#123]).` and, at the bottom of this file,
     `[#123]: https://github.com/lucianodiisouza/recta-selfhosted-backend/pull/123`. -->
