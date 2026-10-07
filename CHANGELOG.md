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

- A credit card created without a closing day now stores one derived from its due day (due day - 7, wrapping into the previous month: due 9 closes on 2, due 3 on 26). An explicit closing day still wins.
- **Effect on existing data:** cards that have a due day and no closing day stored used to get the calendar-month invoice window; the invoice, pay and undo-payment paths now use due day - 7 for them, so invoice totals for those cards change (the window starts and ends on different days). Set an explicit closing day on a card to keep a different window.

### Deprecated

- `bestDayOffset` on create and update account: still accepted so older clients keep validating, but ignored, and it no longer defaults to 10. The best day to buy is the closing day.

### Fixed

- Credit card invoice window is computed with UTC date-only bounds. Local-time bounds were truncated to the UTC day by Prisma in time zones behind UTC, so the closing day was counted in two invoices. A closing day past the end of a short month (30 in February) now closes on that month's last day.
- Undoing an invoice payment no longer marks purchases as unpaid beyond the end of that invoice's own window when the payment is dated later.

<!-- Reference entries to their PR like this (see CONTRIBUTING.md): `... ([#123]).` and, at the bottom of this file,
     `[#123]: https://github.com/lucianodiisouza/recta-selfhosted-backend/pull/123`. -->
