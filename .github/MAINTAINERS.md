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
to `develop`, daily at 06:23 UTC, and on manual dispatch. New `develop` pushes
cancel superseded push runs; nightly and manual runs execute independently.
Nightly runs do not depend on a new beta version: they also detect staging
changes between CLI releases.

Stable publishing requires a passing live suite for the exact release commit.
The release workflow reuses a verified successful staging run on `develop` for
that commit when available; otherwise it runs the suite before publishing.
Normal promotion fast-forwards that commit from `develop` to `main`. The gate
deliberately queries `develop` runs of `live-e2e.yml`; renaming the workflow
requires updating that selector. Actions API lookup errors and live-test
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

## Deferred: automatic Linear → GitHub label sync

We considered auto-applying `open-for-contribution` when a Linear issue moves out of
Triage/Backlog (e.g. to Todo). Linear's native GitHub automations are one-directional
(GitHub events update Linear status) and cannot push a GitHub label, so this would need an
external bridge (a scheduled job polling the Linear API, a Zapier/Make zap, or a Linear
webhook → relay). It is **out of scope for now** and tracked separately; until then, apply
the label manually as above.
