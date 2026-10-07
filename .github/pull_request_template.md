## What changed

<!-- One paragraph or bullet list: the observable behaviour before vs. after. -->

## Why

<!-- The motivation: bug fix, new feature, performance, correctness. Link the related issue, if any. -->

## Test plan

- [ ] `npm ci` and `npm run db:generate` run without errors
- [ ] `npm run typecheck` passes
- [ ] `npm run build` passes
- [ ] `npm test` (`vitest run`) passes, including this PR's new test (seen failing before the code)
- [ ] `git diff --check` passes
- [ ] If there is a migration: `npm run db:deploy` on an empty database applies everything and `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` exits 0
- [ ] No real data (statements, names, e-mails, personal amounts) in tests, fixtures or comments
- [ ] Manual test: <!-- describe what you ran and what you observed -->

## Commit attribution

- [ ] I verified the name and e-mail on every commit in this PR and corrected any unintended identity before requesting merge. See the [commit attribution guidance](https://github.com/lucianodiisouza/recta-selfhosted-backend/blob/main/CONTRIBUTING.md#commit-attribution).

## Release impact

<!-- Check exactly one. This drives which release your change ships in
     (see CONTRIBUTING.md, "Versioning and deprecation policy"). -->

- [ ] **Patch**: bug fix, no new surface
- [ ] **Minor**: additive (route, optional field, environment variable, additive migration)
- [ ] **Major (breaking)**: data format change, removed or renamed route or field, destructive migration. Call it out in "What changed" above

## CHANGELOG (merge gate)

- [ ] I added a `CHANGELOG.md` entry under `[Unreleased]`, in the right section (Added / Changed / Fixed). **Required** for any change visible to users or to whoever self-hosts: route, environment variable, changed behaviour, observable bug fix. (Exempt only: internal refactors, dead-code removal and test-only churn.)
- [ ] Any changed **default** (default value, response shape, environment variable) is called out explicitly in "What changed" above.

Reviewers treat a missing entry as blocking; adding it up front saves a review round.

## How to revert

<!-- How to undo this PR: does `git revert` of the merge/squash commit work? If there is a migration, it is
     additive and stays in the database (see CONTRIBUTING.md); say what is left after the revert and whether
     the frontend/backend pair must be reverted in a particular order. -->

## Notes for reviewers

<!-- Anything tricky, a design decision you made, or areas you would like extra scrutiny on. -->
