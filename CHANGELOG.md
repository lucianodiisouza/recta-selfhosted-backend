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
- `POST /accounts/:id/adjust-balance` accepts an optional `date` (`YYYY-MM-DD`, from 1900-01-01 up to today), so an opening balance can be dated at the end of the previous year and stay out of the current year's income/expense reports.

### Changed

- `POST /accounts/:id/adjust-balance` locks the account row and records a single adjustment entry for the difference, so two concurrent adjustments of the same target apply once. The lock protects an adjustment against another adjustment only: a transaction created at the same moment is not serialized by it (pre-existing limitation, not changed here). For credit cards the balance is the debt, so a higher balance is recorded as an expense.

### Fixed

- `adjust-balance` rejects `null`, `false`, `true`, hex and exponent values for `newBalance` instead of coercing them to `0` (which silently zeroed the account).

<!-- Reference entries to their PR like this (see CONTRIBUTING.md): `... ([#123]).` and, at the bottom of this file,
     `[#123]: https://github.com/lucianodiisouza/recta-selfhosted-backend/pull/123`. -->
