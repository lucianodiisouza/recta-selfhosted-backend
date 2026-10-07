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
- Card invoice OFX preview: `POST /transactions/import/card-ofx/preview` reads a credit card invoice (an OFX with a `CCSTMTRS` block) and, without saving anything, returns the invoice month (derived from the closing date and the card's due and closing days, or overridden), the lines with their kind, installment and status (new, payment), the lines it could not read, how the invoice's payment lines compare with the payments already recorded for the previous invoice, and warning codes.

### Changed

- A credit card created without a closing day now stores one derived from its due day (due day - 7, wrapping into the previous month: due 9 closes on 2, due 3 on 26). An explicit closing day still wins.
- **Effect on existing data:** cards that have a due day and no closing day stored used to get the calendar-month invoice window; the invoice, pay and undo-payment paths now use due day - 7 for them, so invoice totals for those cards change (the window starts and ends on different days). Set an explicit closing day on a card to keep a different window.

### Deprecated

- `bestDayOffset` on create and update account: still accepted so older clients keep validating, but ignored, and it no longer defaults to 10. The best day to buy is the closing day.

### Fixed

- Credit card invoice window is computed with UTC date-only bounds. Local-time bounds were truncated to the UTC day by Prisma in time zones behind UTC, so the closing day was counted in two invoices. A closing day past the end of a short month (30 in February) now closes on that month's last day.
- Undoing an invoice payment no longer marks purchases as unpaid beyond the end of that invoice's own window when the payment is dated later.
- Credit card invoice payments (`invoice_pay:<card>:<year>-<zero-based month>`) are counted by the invoice they pay, not by the window their date falls in. A payment is dated on or after the closing day of its own invoice, so the date window never contained it: the paid invoice stayed in the next invoice's previous balance and the debt was counted twice. Payments tagged for an earlier invoice reduce the previous balance, payments tagged for the invoice itself count as its payments, and payments tagged for a later invoice (paid in advance) are not subtracted from earlier ones. Pay and the invoice view share one helper.
- A payment dated after today (scheduled for an upcoming due date) no longer counts as paid until its date arrives.
- The list of an invoice's transactions shows only the payments already made (dated up to today, by the UTC date: between 21:00 and midnight in Brasília a payment dated tomorrow already counts), so it agrees with the invoice total instead of listing a payment scheduled for the due date as if it had been paid.
- A card with no purchases before the invoice window (its initial debt comes from the account balance) now counts payments by the invoice they pay, like the rest of the invoice and the payment, instead of by the dates inside the window: a payment for this invoice, or made ahead for a later one, is added back to the balance estimate wherever it is dated, and a payment for an earlier invoice is not (so one made after the window closes no longer inflates the previous balance, and one made inside the window is no longer ignored in the total). A payment dated in the future that the balance already holds still counts through the balance, as it did before.

<!-- Reference entries to their PR like this (see CONTRIBUTING.md): `... ([#123]).` and, at the bottom of this file,
     `[#123]: https://github.com/lucianodiisouza/recta-selfhosted-backend/pull/123`. -->
