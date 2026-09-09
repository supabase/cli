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

Shadow mode: `workflow_dispatch` or an exact `/ai-dogfood-and-review`
comment (a trailing body after a newline is still that command). No
`pull_request` auto trigger.

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
  No staging token. Fail-fast if the PR does not install; that skip means no
  dogfood report and no chained `/ai-review` (use `/ai-review` directly).
- **`dogfood`** — copies pinned corpus samples, runs Codex (`gpt-5.6-luna`)
  with `sb` as the only CLI entrypoint, then sweeps leftover staging projects.
  Does not build `supabase-go`; a missing sidecar is a harness `skip`, not a
  product `no-go`.
- **`post-report`** — trusted checkout; re-redacts and posts one issue
  comment tagged `<!-- supabase-ai-dogfood -->`. On agent crash (dogfood ran
  but produced no valid report), posts a `no-go` stub so review still has
  context.
- **`dispatch-review`** — `gh workflow run ai-review.yml` against the default
  branch after a report is posted, including on `no-go`. Not dispatched when
  `build-cli` fails.

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
  written to `${RUNNER_TEMP}/dogfood.token` for the trusted `sb` wrapper, then
  passed only to the CLI child. Untrusted `bunfig.toml` / `.npmrc` / `.env` /
  `.pnpmfile.*` in the PR checkout are renamed aside. Install uses
  `--ignore-scripts` and `--ignore-pnpmfile`.
- Codex uses `safety-strategy: drop-sudo` (same as review) but **cannot** use
  review's `sandbox: read-only`: it must write scratch files, talk to
  `api.supabase.green`, and drive Docker. Legacy `workspace-write` blocks
  outbound network and the Docker socket, so v1 uses `danger-full-access`.
  Never silently reuse `read-only`. Under that sandbox, `RUNNER_TEMP` is still
  readable; keeping the token out of the scratch cwd is hygiene, not a
  security boundary.
- `sb` refuses to run without a non-empty token file and rejects
  `projects create` unless some argument starts with the run's project
  prefix (so sweep can always find leftovers).
- After Codex, the dogfood job deletes and checks out `trusted/` again before
  validate/redact, and uploads `report.json` only if that step succeeds.
  `post-report` re-redacts on a fresh runner before posting the comment.
- A malicious same-repo PR can still abuse the staging token once the CLI
  runs. The wrapper, fork ban, maintainer trigger, unique project prefix, and
  always-on sweep are the blast-radius limits. Treat artifacts and the posted
  comment as public; reports are secret-scrubbed (`sbp_…` included) before
  upload or post.
- Advisory only: the functional report is an issue comment, not
  `APPROVE` / `REQUEST_CHANGES`. This workflow is not a required check and
  never runs in `merge_group`.

## Corpus

Samples come from the public
[`matlin/supabase-config-real-world-samples`](https://github.com/matlin/supabase-config-real-world-samples)
repo at the commit in `corpus.sha`. Default first-pass trees:
`usebasejump__basejump` and `vercel__nextjs-subscription-payments`. Copy into
scratch; never mutate the clone.

This directory is a CI agent brief. It is not the private local playbook
library and must not grow into a copy of it.

## Rollout

Prompts, schemas, and scripts come from a **trusted ref**: the default
branch on `/ai-dogfood-and-review` comments, or the branch selected in the
Actions UI on `workflow_dispatch` (same-repo only, matching live-e2e).
Comment-triggered runs therefore only pick up this pipeline after it lands
on `develop`.
