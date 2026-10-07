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
- Bank statement import: `POST /transactions/import/preview` parses an OFX or CSV file (up to 5 MB and 1500 rows) and flags the rows the account already holds, comparing by occurrence so identical rows in one file are all kept; it also lists the lines it could not read. `POST /transactions/import/confirm` creates the rows the user kept, one import at a time per account (a second one answers 409), and reports where it stopped if a row fails. Adds the `@fastify/multipart` dependency.
- Statement import decodes files as UTF-8 first and falls back to Windows-1252 whatever `CHARSET` they declare, and leaves unknown or inherited entity names such as `&constructor;` untouched in memos.

<!-- Reference entries to their PR like this (see CONTRIBUTING.md): `... ([#123]).` and, at the bottom of this file,
     `[#123]: https://github.com/lucianodiisouza/recta-selfhosted-backend/pull/123`. -->
