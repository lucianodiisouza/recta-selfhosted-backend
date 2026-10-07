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
- `AUTH_MODE=local`: sign-in with email and password and self-issued JWTs, with no Firebase. New public routes `POST /auth/register` and `POST /auth/login`, and `GET /auth/config` so clients can discover the mode. Requires `AUTH_JWT_SECRET` (32+ characters); `AUTH_TOKEN_TTL_HOURS` sets the token lifetime (default 720). Emails are trimmed and lowercased, passwords are 8 to 72 bytes, both routes are limited to 10 requests per minute per IP, and an email can fail to sign in 30 times per hour (429 as an error object, with `Retry-After` for the email limit). `AUTH_TOKEN_TTL_HOURS` must be positive (at most one year).
- `AUTH_ALLOW_REGISTRATION` (default `true`): when `false`, `POST /auth/register` answers 403, and `GET /auth/config` reports `registrationEnabled`.
- Migration `auth_mode_local`: adds `users.password_hash` (nullable) and makes `users.firebase_uid` nullable.

### Fixed

- Authentication error responses are documented in the routes' schemas as the `{ success, error: { code, message } }` object the API already returns.
- `POST /users/me/reset` and `DELETE /users/me` find the user by id in local mode instead of by Firebase UID.
- Inviting a household member matches the email ignoring case.
- Removed the documentation of `AUTH_REQUIRE_EMAIL_VERIFICATION` from the README and `env.example`: nothing reads that variable.

<!-- Reference entries to their PR like this (see CONTRIBUTING.md): `... ([#123]).` and, at the bottom of this file,
     `[#123]: https://github.com/lucianodiisouza/recta-selfhosted-backend/pull/123`. -->
