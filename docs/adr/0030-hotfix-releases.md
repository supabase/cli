# 0030. Hotfix releases

**Status**: accepted
**Date**: 2026-10-07

## Problem Statement

A stable CLI fix sometimes cannot wait for the weekly `develop` -> `main` promotion. The documented `hotfix/*` path into `main` had never been exercised. A mistitled hotfix merged, published nothing, and told nobody; the build-and-smoke rehearsal that a beta normally provides was a manual dispatch nothing enforced; and the release runbook offered a channel rollback as the first response to a bad release, which needed npm and tap permissions few maintainers hold. [ADR 0028](0028-release-branches-and-maintenance-lines.md) fixed the back-merge of `main` into `develop` and gave hotfix PRs the test suite; this ADR records the rest.

## Decision

- **Criteria.** A hotfix fixes the current stable for a problem users cannot work around and that should not wait for the next promotion: a regression from the last release, a security fix, or breakage caused by a platform change. Anything else goes through `develop`. Only `main`'s tip is hotfixed; `v<N>.x` maintenance lines reuse the `hotfix/*` branch prefix to satisfy their source check and are released by manual dispatch as described in ADR 0028.
- **Forward-only.** There is no channel rollback. The fastest response to a regression whose cause is not yet understood is a `revert:` PR into `main`, which publishes a patch through the normal pipeline. The real fix follows as a revert of the revert plus the fix.
- **A required title check.** `Check deploy` runs on every PR into `main` and always reports. It succeeds on the scheduled `develop` promotion, requires a `fix`, `perf`, or `revert` title without `!` on `hotfix/*` heads, and fails on any other head. It becomes a required status check on `main` once the always-run version has been promoted there. It must always run because `main` has no ruleset bypass for the release App, so the deploy fast-forward push is evaluated against every required check on `main` and the promotion's head SHA needs a real success.
- **An automatic rehearsal.** `Release Smoke Test` runs its dry-run build-and-smoke pass on every hotfix PR, replacing the manual dispatch. A non-dry-run stable release can only be dispatched from `main`.
- **Notifications.** A `main-into-develop` sync conflict is announced in the release Slack channel, and a deploy fast-forward refused because `develop` lacks `main` names the open sync PR.

## Rationale

- A mistitled hotfix was the only mistake in the flow that failed silently, so it gets a machine check and, later, a merge block.
- Almost every stable release has been preceded by a beta built from nearly the same code, so packaging breaks surface as a red beta with stable untouched. A hotfix skips beta; the automatic dry run restores that coverage without a branch picker or a version to type.
- A rollback can take as long as a hotfix or longer because of npm dist-tag nuances, and it does not reach users who already upgraded. A revert hotfix gets everyone to a known-good build through the same audited pipeline and needs no extra permissions.
- The stable success message and a back-merge conflict land in the same channel minutes apart, in front of the person who just shipped the hotfix.

## Consequences

### Positive

- A stable fix ships without waiting for Tuesday, with the same automated checks a normal release has.
- No npm or tap credentials need distributing for incident response.
- A hotfix cannot merge with a title that publishes nothing.

### Negative

- A revert hotfix ships a release even when the regression could have been patched in place; a second release follows with the fix.
- `Check deploy` only guards the PR title. A subject edited in the squash dialog bypasses it; the runbook says not to.
- Until `Check deploy` is a required check, a red result is advisory.

## Alternatives Considered

1. **Channel rollback before hotfixing**: repoint npm `latest`, revert the Homebrew and Scoop manifest commits, edit the GitHub Release. Rejected: slower and riskier than it looks, needs permissions few hold, and leaves upgraded users behind.
2. **Fix on `develop` first, cherry-pick to `main`**: the fix gets a beta for free, but `main` is usually far behind `develop`, the cherry-pick often does not apply cleanly, and the live e2e gate re-runs anyway because the SHA differs.
3. **Promote `develop` early instead of hotfixing**: ships every unreleased change alongside the fix.
4. **Manual dry-run dispatch before merge**: the previous documented step. Nothing enforced it and it required the operator to pick the branch and type the next version.

## Related Decisions

- [ADR 0011](0011-cli-release-and-distribution-strategy.md): the release and distribution strategy.
- [ADR 0028](0028-release-branches-and-maintenance-lines.md): branches, sync, fast-forward safety, and maintenance lines.

## See Also

- [`apps/cli/docs/release-process.md`](../../apps/cli/docs/release-process.md): the hotfix runbook and the rollback policy.
