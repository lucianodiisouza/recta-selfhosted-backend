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
- Recurring-expense detection: `POST /recurring-transactions/detect` proposes monthly recurrences (stable subscriptions and variable monthly bills) from the paid expense history, and `POST /recurring-transactions/detect/apply` creates the chosen ones and links the history to them without touching any balance.
- Recurrences that follow the last value: `followLastAmount` on `POST` and `PATCH /recurring-transactions` (migration `20261005140000_recurring_follow_last_amount`, default `false`). Editing the amount of the most recent occurrence updates the recurrence in the same database transaction and the `PATCH /transactions/:id` response carries `recurringUpdated`. `GET /recurring-transactions` items carry `lastOccurrenceDate`.
- Category management: `POST /categories/:categoryId/merge` (with `?preview=true`) merges a custom category into another category of the same type, `GET /categories?includeUsage=true` returns usage counts, names are unique per household and type ignoring case and accents (`409 CATEGORY_NAME_TAKEN`), and `PATCH /categories` renames and recolours.

### Changed

- A monthly recurrence has at most one occurrence per month: executing it (cron, `POST /recurring-transactions/:id/execute`) when the month already holds a transaction of that recurrence only moves `nextRunAt` on, under a per-recurrence lock.
- The default `followLastAmount: true` on detected candidates is a product decision: a recurrence created from the history follows the real value unless the user turns it off.
- A category name that differs from an existing one only by case, accents or spaces, or that equals a system category of the same type, is now refused when creating or renaming a custom category (`409 CATEGORY_NAME_TAKEN`); existing categories are not touched. The check runs before the insert, so simultaneous creates of near-identical names can still all succeed; a merge fixes it (see README).

### Fixed

- `POST /categories`, `PATCH /categories/:categoryId` and `GET /categories/:categoryId` declared an empty `data` object in their response schema and returned `data: {}`; they now return the category.
- A transaction, recurring transaction, budget or detected recurrence that names a custom category deleted or merged meanwhile is refused with `400` instead of being stored with a reference to a category that no longer exists. Deleting a category now checks its usage and deletes it in one database transaction.

<!-- Reference entries to their PR like this (see CONTRIBUTING.md): `... ([#123]).` and, at the bottom of this file,
     `[#123]: https://github.com/lucianodiisouza/recta-selfhosted-backend/pull/123`. -->
