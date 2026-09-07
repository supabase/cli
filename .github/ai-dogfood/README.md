# AI dogfood and review

A GitHub Actions pipeline (`.github/workflows/ai-dogfood-and-review.yml`) that
runs the PR's CLI against a real-world sample and a throwaway staging project,
posts one **functional report** comment, then dispatches the existing
[`/ai-review`](../ai-review/README.md) pipeline so Claude + Codex review the
diff with that report as runtime evidence.

Two maintainer comments:

| Comment                  | What runs                                                         |
| ------------------------ | ----------------------------------------------------------------- |
| `/ai-review`             | Code review only. No CLI execution, no staging token.             |
| `/ai-dogfood-and-review` | GPT 5.6-luna dogfood, then `/ai-review` with the report attached. |

Shadow mode (safe flow): `workflow_dispatch` or an exact `/ai-dogfood-and-review`
comment. No `pull_request` auto trigger.

**Pre-merge debug (temporary):** this workflow file is not on the default branch
yet, so dispatch and comments cannot start it. PR **#6495** currently triggers
on `pull_request` so we can exercise the pipeline against itself: trusted
scripts come from the PR head, and the chained `ai-review.yml` dispatch targets
this branch. Remove the `pull_request` trigger and restore default-branch trust
before merge.

## Why

Local dogfooding already pins the PR CLI, copies a corpus sample, exercises
user-facing commands (including staging), and writes a go / conditional / no-go
report. That report was never an input to CI code review. This pipeline is that
loop, in Actions, with a cheaper Codex model (`gpt-5.6-luna`, `effort: medium`)
than the review pass (`claude-opus-5` + `gpt-5.6-sol`, `effort: high`).

## Stages

```
resolve ──> build-cli ──> dogfood ──> post-report ──> workflow_dispatch ai-review.yml
(auth,        (PR CLI,      (luna +     (one PR         (existing review jobs
 same-repo)    no token)     corpus +    comment)         consume the comment)
                             staging)
```

- **`resolve`** — same write/admin gate as `/ai-review`, exact first-line
  command match, 👀 on the comment. Forks are refused even on manual dispatch
  (this job executes PR code with a staging token).
- **`build-cli`** — installs the PR workspace with the trusted toolchain pin.
  No staging token. Fail-fast if the PR does not install.
- **`dogfood`** — copies pinned corpus samples, runs Codex (`gpt-5.6-luna`)
  with `sb` as the only CLI entrypoint, then sweeps leftover staging projects.
- **`post-report`** — trusted checkout; validates + redacts + posts one issue
  comment tagged `<!-- supabase-ai-dogfood -->`. On agent crash, posts a
  `no-go` stub so review still has context.
- **`dispatch-review`** — `gh workflow run ai-review.yml` against the default
  branch. Always dispatched, including on `no-go`.

## Required secrets

- `OPENAI_API_KEY` — same key as `/ai-review` Codex jobs. No Anthropic key on
  this workflow.
- `SUPABASE_E2E_CLI_LIVE_STAGING_ACCESS_TOKEN` — same staging token as
  `live-e2e.yml`. Scoped to the wrapper-write step, the Codex child via `sb`,
  and the always-on sweep. Never injected into Codex's own environment.

## Security model

This pipeline **must execute** the PR CLI, which `/ai-review` deliberately
never does. Containment, not proof of isolation:

- Maintainer write/admin (or repository owner) only; exact `/ai-dogfood-and-review`.
- Same-repo PRs only, including `workflow_dispatch`. Forks never see the
  staging token.
- Dual checkout: prompts, schemas, and scripts come from the default branch;
  the PR tree is the CLI under test. Codex `working-directory` is the scratch
  corpus copy, so a PR-authored `AGENTS.md` is not auto-loaded.
- `build-cli` and the dogfood install step hold no staging token. The token is
  written to a file the trusted `sb` wrapper reads, then passed only to the
  CLI child. Untrusted `bunfig.toml` / `.npmrc` / `.env` in the PR checkout
  are renamed aside before `pnpm install`.
- Codex uses `safety-strategy: drop-sudo` (same as review) but **cannot** use
  review's `sandbox: read-only`: it must write scratch files, talk to
  `api.supabase.green`, and drive Docker. Legacy `workspace-write` blocks
  outbound network and the Docker socket, so v1 uses `danger-full-access`.
  Never silently reuse `read-only`.
- A malicious same-repo PR can still abuse the staging token once the CLI
  runs. The wrapper, fork ban, maintainer trigger, unique project prefix, and
  always-on sweep are the blast-radius limits. Treat artifacts and the posted
  comment as public; reports are secret-scrubbed (`sbp_…` included) before
  upload or post.
- Advisory only: the functional report is an issue comment, not
  `APPROVE` / `REQUEST_CHANGES`. This workflow is not a required check and
  never runs in `merge_group`.

## Corpus

Samples come from `supabase/supabase-config-real-world-samples` (internal) at the
commit in `corpus.sha`. CI clones it with the org GitHub App (`GH_APP_*`); the
default `GITHUB_TOKEN` cannot read that repo. Default first-pass trees:
`usebasejump__basejump` and `vercel__nextjs-subscription-payments`. Copy into
scratch; never mutate the clone.

This directory is a CI agent brief. It is not the private local playbook
library and must not grow into a copy of it.

## Rollout

Prompts, schemas, and scripts come from a **trusted ref**: the default
branch on `/ai-dogfood-and-review` comments, or the branch selected in the
Actions UI on `workflow_dispatch` (same-repo only, matching live-e2e).
Comment-triggered runs therefore only pick up this pipeline after it lands
on `develop`. Until then, the #6495 `pull_request` debug trigger (see above)
is the way to iterate; revert it before merge.
