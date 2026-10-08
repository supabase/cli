# Maintainers guide

Internal notes for maintaining the Supabase CLI contribution workflow. See
[`CONTRIBUTING.md`](../CONTRIBUTING.md) for the contributor-facing version.

## The `open-for-contribution` gate

External pull requests are only accepted when they link to an **open** GitHub issue
that carries the **`open-for-contribution`** label. This is enforced by the
[`Contribution Gate`](./workflows/contribution-gate.yml) workflow, whose decision logic
lives in [`scripts/contribution-gate.ts`](./scripts/contribution-gate.ts).

The gate runs **reactively on each PR** so a non-conforming PR is closed right away, and
can also be **swept across every open PR on demand** via the workflow's _Run workflow_
button.

A pull request is **auto-closed with an explanatory comment** when the author is external
and any of these is true:

- no issue is linked (via a closing keyword such as `Closes #123`, or the PR's
  Development sidebar), or
- the linked issue is closed, or
- the linked issue is missing the `open-for-contribution` label.

Authors whose `author_association` is `OWNER`, `MEMBER`, or `COLLABORATOR`, and bot
accounts, are **exempt** — Supabase maintainers can keep working from Linear tickets that
aren't public on GitHub.

### Running the gate manually

Use **Actions → Contribution Gate → Run workflow** to sweep all open PRs on demand — for
example right after bulk-applying `open-for-contribution` labels, so the whole backlog is
re-evaluated at once instead of waiting for each PR's next edit. Set the **`dry_run`**
input to `true` first to log each PR's decision in the run output without commenting on or
closing anything; run again with `dry_run` unchecked to apply the decisions.

## Triage: applying the label (manual)

During triage:

1. Categorize the issue with one of `✨ Feature`, `🐛 Bug`, or `📘 Docs`. Issues opened
   via the templates start with their category label already applied.
2. When the issue is ready to be worked on, add the **`open-for-contribution`** label.

The `open-for-contribution` label must exist as a repository label for this workflow to
function; create it once from **Issues → Labels** if it is missing.

Applying `open-for-contribution` is currently a **manual step** — do it on the GitHub
issue directly (from the GitHub UI, or from the Linear-linked issue).

## `run-ci`: full develop CI on stacked or draft PRs

Ready (non-draft) PRs targeting `develop` already get the default suite: Test
(check / unit+integration / e2e) and PR-title lint.

Stacked PRs (base is another PR branch) and drafts do **not** get that suite
unless they carry the **`run-ci`** label. [`run-ci.yml`](./workflows/run-ci.yml)
then calls Test as a reusable workflow, including while the PR is still a draft.

- Add `run-ci` to start (or resume) the suite; remove it to cancel in-progress
  `run-ci` runs via that workflow's concurrency group.
- Other labels do not start or cancel Test. PR-title lint may retrigger because
  that check is cheap.
- After a stacked PR is retargeted onto `develop`, push or reopen so the
  native required checks (`Check code quality`, etc.) populate. The opt-in
  suite uses different check names (`Test / Check code quality`).
- This is independent of `run-preview-packages` and `run-live-e2e-ci`.

The `run-ci` label must exist as a repository label; create it from
**Issues → Labels** if it is missing.

## `run-preview-packages`: on-demand pkg.pr.new preview

CLI preview packages are large, so they are **not** published on every PR.
Add the **`run-preview-packages`** label to publish via
[`publish-preview-cli-packages.yml`](./workflows/publish-preview-cli-packages.yml)
(any base branch, including drafts). While the label stays on, each subsequent
push re-publishes; remove it to cancel in-progress runs.

The workflow posts (or updates) a PR comment with an `npx` install command for
the preview. This is independent of `run-ci` and `run-live-e2e-ci`.

The `run-preview-packages` label must exist as a repository label; create it
from **Issues → Labels** if it is missing.

## Live e2e coverage and stable releases

[`Live E2E`](./workflows/live-e2e.yml) exercises managed staging after every push
to `develop`, daily at 06:23 UTC, and on manual dispatch. The nightly run also
dispatches `main` and `next` (when it exists), so each branch has its own runs. New `develop` pushes
replace only a queued push run; nightly and manual runs execute independently.
Nightly runs do not depend on a new beta version: they also detect staging
changes between CLI releases.

Stable and maintenance publishing requires a passing live suite for the exact
release commit. The release workflow reuses a verified successful staging run
for that commit when available; otherwise it runs the suite before publishing.
Normal promotion fast-forwards that commit from `develop` to `main`, so stable
reuses the `develop` run. The gate queries runs of `live-e2e.yml` for the
branch passed in its `branch` input (`develop` by default, the `v<N>.x` ref for
maintenance releases); renaming the workflow requires updating that selector. Actions API lookup errors and live-test
failures block publication. This also applies to
manual stable releases. Beta publication keeps its existing build and smoke-test
gates.

Live-test failures and recoveries are sent to the channel configured by
`SLACK_RELEASE_WEBHOOK`, with commit and workflow links. Routine successful runs
stay quiet. GitHub Actions logs contain the test failures; notification delivery
does not determine whether the suite passed.

PR live coverage remains opt-in through `run-live-e2e-ci`. That label dispatches
the PR commit to the separate Supabox harness, which also has its own nightly
schedule against pinned submodules. A Supabox result does not replace the
managed-staging gate for stable publication.

The gate and notifier identify the reusable suite by the `Live e2e` job name (or
the exact ` / Live e2e` suffix). The gate also checks the `Run live e2e` step
name. Keep these names aligned with their consumers. Push, scheduled, manual, and stable-gate runs
use separate concurrency groups because they own independent temporary project
sets; this is intentional and does not imply a global concurrency quota.
Notification history inspects at most 25 recent runs of the same workflow and
branch. It suppresses repeated outcomes and results superseded by a newer run
or attempt. Recovery requires a known prior failure. History lookup errors
produce warnings; a confirmed current failure can still be reported if its
prior outcome is unknown. Release failures use the existing release notification
to avoid a second failure alert from the live notifier.

## Branches and releases

Full procedures live in the
[release process runbook](../apps/cli/docs/release-process.md); the decision is
[ADR 0028](../docs/adr/0028-release-branches-and-maintenance-lines.md).

**Resolving a sync PR.** When `Sync branches` cannot merge cleanly it opens
`sync/<source>-into-<target>` (for example `sync/develop-into-next`). Further
syncs for that pair skip while it is open. Merge the target into the sync
branch, resolve, and push; then **approve** the PR. Approval fast-forwards the
target and deletes the branch. Never use the merge button. If the target or the
source moved, the bot merges the latest target and source into the approved head and lands
it directly if the merge is clean, as for a clean sync (the merge commit is
untested); only a new conflict, or a target that keeps moving, sends the PR
back for a new approval. Only two sync pairs
exist (`sync/main-into-develop` into `develop`, `sync/develop-into-next` into
`next`), and only the release bot's PRs from those branches qualify; approving
a hand-made PR from one of them is refused with a comment (close it and run
`gh workflow run sync-branches.yml -f pair=<pair>`). One
maintainer may both resolve and approve a sync PR: that is an accepted
decision, since resolvers are trusted maintainers and the resolution is not
independently reviewed.

**Approving a fast-forward.** The approver needs write access, and the approved
commit must still be the PR head with the four required checks green.
Fast-forward PRs are the deploy PR (`develop` → `main`), the major cut
(`next` → `develop`), and the two sync PRs.

**Dispatch guards.** `release.yml` refuses `channel=next` off `next`,
`channel=maintenance` off `v<N>.x`, `beta`/`stable` on `next` or `v<N>.x`, a
non-dry-run `stable` outside `main`, and a `version` that is not
`X.Y.Z[-prerelease]`.

**`release-major` label.** The deploy fast-forward refuses a major version bump
unless the deploy PR carries `release-major`. Add it only when shipping a major
on purpose.

**Cutting a major.** Pause the `develop` merge queue, make sure `next` contains
`develop` (no open `sync/develop-into-next` PR), open a PR `next` → `develop`
and approve it, then resume the queue. See
[Cutting a major](../apps/cli/docs/release-process.md#cutting-a-major-v3-runbook).

**Maintenance releases.** After a fix merges into `v<N>.x`, dry-run first, then
publish; leave `version` empty:

```sh
gh workflow run release.yml --ref v2.x -f channel=maintenance -f dry_run=true
gh workflow run release.yml --ref v2.x -f channel=maintenance -f dry_run=false
```

Only security fixes and fixes for fundamentally broken behaviour go into
`v<N>.x`, through `hotfix/*` or `backport/*` PRs. Release-infrastructure changes
must be cherry-picked to every active `v*.x` (see
[Release infra and maintenance lines](../apps/cli/docs/release-process.md#release-infra-and-maintenance-lines)).

**Manual setup (rulesets and labels).**

- Create the `next` branch from `develop`, and the `release-major` label.
- Add `Require fast-forward` (from `branch-policy.yml`, which runs on `pull_request_target`) as a required check on
  `develop` and `next`. `next` also needs the merge queue, the four checks
  required on `develop` (`Check code quality`, `Run unit and integration tests`,
  `Run end-to-end tests`, `Lint Pull Request`), and release App bypass.
- Add a `v*.x` ruleset with release App bypass and `Check maintenance source` as
  a required check.
- Confirm the npm trusted publisher for `supabase` still points at `release.yml`.

## Deferred: automatic Linear → GitHub label sync

We considered auto-applying `open-for-contribution` when a Linear issue moves out of
Triage/Backlog (e.g. to Todo). Linear's native GitHub automations are one-directional
(GitHub events update Linear status) and cannot push a GitHub label, so this would need an
external bridge (a scheduled job polling the Linear API, a Zapier/Make zap, or a Linear
webhook → relay). It is **out of scope for now** and tracked separately; until then, apply
the label manually as above.
