# 0028. Release branches and maintenance lines

**Status**: accepted
**Date**: 2026-10-07

## Problem Statement

[ADR 0011](0011-cli-release-and-distribution-strategy.md) defines three npm dist-tags: `latest` from `main`, `beta` from `develop`, and `alpha` for a "next shell" that no longer exists in the tree. There is nowhere to integrate a breaking change while `develop` keeps shipping non-breaking betas, and no way to patch a previous major once a new one ships. Both are needed before the next major release.

## Decision

Add two release channels and the branches behind them. `develop` and `main` are unchanged.

| Branch    | Purpose                                       | Version        | npm dist-tag  | Homebrew / Scoop                        | GitHub release          |
| --------- | --------------------------------------------- | -------------- | ------------- | --------------------------------------- | ----------------------- |
| `develop` | Non-breaking integration                      | `X.Y.Z-beta.N` | `beta`        | `supabase-beta`                         | prerelease              |
| `main`    | Stable                                        | `X.Y.Z`        | `latest`      | `supabase`                              | latest                  |
| `next`    | Breaking-change integration, tracks `develop` | `X.Y.Z-next.N` | `next`        | none                                    | prerelease              |
| `v<N>.x`  | Maintenance for a past major                  | `N.Y.Z`        | `v<N>.stable` | `supabase@<N>` / `supabase-v<N>-stable` | published, never latest |

- **`next`** is one long-lived branch reused for every major. Breaking PRs target it with a `type(scope)!:` title, enforced by the PR title lint. Every push runs the full test suite before publishing. The prerelease identifier is `next`, not `beta`, so versions do not collide on npm after a cut. Publishing stays OIDC-only, so the stable release does not move the `next` dist-tag; `supabase@next` catches up on the next push to `next`.
- **`develop` → `next`** is kept in sync on every push, and `main` → `develop` after every stable release. A clean merge is pushed directly. A conflict opens a PR from `sync/<source>-into-<target>` (at the source tip) into the target, and approving it fast-forwards the target to the PR head.
- **Fast-forward on approval** applies to the deploy PR (`develop` → `main`), the major cut (`next` → `develop`), and sync PRs. The approver must have write access; the approved commit must be the PR head with the required checks green; the target must fast-forward (for a sync PR, a clean merge of the moved target lands directly, as for a clean sync; only a new conflict or a target that keeps moving sends it back for re-approval); and a major version bump on the deploy PR needs the `release-major` label. The merge button is blocked on these PRs because the repository is squash-only and squashing destroys the ancestry.
- **`v<N>.x`** is created by hand from the last stable `N.*` tag at the cut of the next major. It is released by dispatching `release.yml` on that ref with `channel=maintenance`; the workflow, scripts, and live e2e tests come from the frozen commit. A wildcard maintenance entry in the semantic-release config covers every such branch. Maintenance releases publish `v<N>.stable` on npm and are never marked latest.
- **What `v<N>.x` accepts**: dependency security patches, our own security fixes, and fixes for fundamentally broken behaviour, via `hotfix/*` or `backport/*` PRs. Two to three stable majors are supported at once, for roughly six to twelve months after the next major ships, ending with a final release on the line.
- **Release infrastructure** changes are cherry-picked by hand to every active `v<N>.x`.

This supersedes the dist-tag section of ADR 0011 ("Why `latest`, `beta`, and `alpha` npm dist-tags"). The "next shell behind `alpha`" wording is retired: that code is gone and no workflow publishes `alpha`. The publish and smoke-test scripts still accept `alpha`; removing it is separate cleanup.

The operational runbook, including the major-cut steps, is [`apps/cli/docs/release-process.md`](../../apps/cli/docs/release-process.md).

## Rationale

- A single reusable `next` branch keeps the breaking-change stream continuous across majors and lets the cut be a fast-forward of `develop` rather than a large merge.
- Syncing `develop` into `next` continuously keeps conflicts small and visible as they appear, instead of at the cut.
- Approving a PR to fast-forward preserves merge ancestry that squash merges would destroy, and reuses the existing deploy gate instead of adding another approval mechanism.
- Running maintenance releases from the maintenance ref avoids a second release workflow and threading a ref through the pipeline; each line is released with the code it was cut with.
- `v<N>.stable` is a valid npm dist-tag (not a semver range), and `supabase@<N>` / `supabase-v<N>-stable` fit Homebrew's versioned-formula and Scoop naming.

## Consequences

### Positive

- Breaking changes have a home that does not block weekly non-breaking releases.
- A major is shipped by an explicit, labelled promotion; an accidental major on `main` is refused.
- Previous majors can receive security and critical fixes.

### Negative

- Release-infrastructure fixes must be cherry-picked to each active `v<N>.x` by hand; Dependabot targets `develop` only.
- The `next` dist-tag can lag behind `latest` until the next push to `next`.
- Every `develop` push triggers a sync and, once `next` exists, a `next` test run and release.
- Rulesets for `next` and `v*.x` and the `release-major` label are manual setup.
- `supabase@<N>` and `supabase` both install `bin/supabase`, so Homebrew can link only one.
- Homebrew and Scoop for `next` are not published.

## Alternatives Considered

1. **Move the `next` dist-tag when a stable release ships**: needs an npm token with dist-tag permission, which the OIDC-only publish job does not have.
2. **Merge `next` into `develop` with a merge commit or squash at the cut**: the repository is squash-only; a squash would discard the history `develop` and `next` share, and the next sync would conflict again.
3. **A dedicated maintenance release workflow**: duplicates the release pipeline and needs explicit ref threading; dispatching the existing workflow on the maintenance ref reuses it as frozen.
4. **Tag-based maintenance with no long-lived branch**: gives backports nowhere to be reviewed, tested, and released from.

## Related Decisions

- [ADR 0011](0011-cli-release-and-distribution-strategy.md): the release and distribution strategy; its dist-tag section is superseded here.
- [ADR 0014](0014-macos-code-signing-and-notarization.md): signing applies to every channel's binaries.

## See Also

- [`apps/cli/docs/release-process.md`](../../apps/cli/docs/release-process.md): channel table, sync and fast-forward behaviour, major-cut and maintenance runbooks.
- [`.github/MAINTAINERS.md`](../../.github/MAINTAINERS.md): maintainer steps and required ruleset checks.
