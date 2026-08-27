# AI Review

A GitHub Actions pipeline (`.github/workflows/ai-review.yml`) that gives every
PR one exhaustive, structured AI review instead of the churn of the Codex
GitHub App's automatic per-push reviews (which re-reviewed a PR 30-40 times
as commits landed). This pipeline runs **exactly once per PR**: no new
commit ever re-triggers it.

## Why

The Codex app's automatic review re-runs on every push, producing dozens of
short, repetitive review rounds per PR and burning reviewer attention on
churn instead of substance. This pipeline instead:

1. Lets Claude do one unhurried, exhaustive pass over the whole diff.
2. Lets Codex do its own independent pass, then adjudicate every Claude
   finding (confirmed / refuted / uncertain) instead of taking it at face
   value.
3. Posts ONE consolidated, deterministic review — no model call decides what
   gets posted or how; a plain TypeScript script does.

## Stages

```
resolve  →  claude-review  →  codex-review  →  post-review
(decide)     (Claude JSON      (Codex review +    (post ONE
              findings)         adjudication)      GitHub review)
```

- **`resolve`** (`.github/scripts/ai-review/resolve.ts`) decides whether this
  run should happen at all, and in which mode. It applies the once-per-PR
  dedup guard, the draft/bot/fork skips (for the future automatic trigger),
  authorization for manual `/ai-review` requests, and a size guard for
  diffs too large to meaningfully review.
- **`claude-review`** gives Claude read-only access to the PR's own head
  commit as review subject matter, and asks it for one exhaustive pass,
  producing structured JSON findings validated against `findings.schema.json`.
- **`codex-review`** performs its own independent review of the diff, then
  adjudicates every Claude finding, merging both into one deduplicated,
  structured result validated against `merged-review.schema.json`.
- **`post-review`** (`.github/scripts/ai-review/post-review.ts`) is the only
  job with write access. It posts one `COMMENT`-event GitHub review (inline
  comments where the diff can anchor them, a summary body for everything
  else), then best-effort supersedes any prior AI review on the PR.

## Once-per-PR semantics and manual re-runs

New commits never re-trigger a review — `resolve.ts`'s dedup guard skips a
PR that already carries a review/comment with the `<!-- supabase-ai-review
-->` marker **posted by this workflow's own bot account**; the marker alone,
if pasted by someone else, does not suppress a review. To get another review
on the same PR:

- a maintainer with repository write access (or the repository owner) posts a
  comment whose first line is exactly `/ai-review`, or
- run the workflow manually via `workflow_dispatch` with the PR number.

Both bypass the dedup guard and the draft/fork/bot skips (a human explicitly
asked), but still respect the size guard.

## Rollout

The pipeline currently runs only on-demand (`workflow_dispatch` or
`/ai-review`) — the `pull_request` trigger in the workflow is commented out
("shadow mode"). Rollout plan:

1. Run it manually against a sample of recent real PRs; tune the two prompts
   in this directory against what it actually produces. **This only works
   end-to-end once the current security fixes are merged to `develop`**: the
   prompts, schemas, and validation script are read from a trusted checkout of
   the _default branch_ (not the PR under review), and `post-review` checks
   out `develop` explicitly — so prompt/script tweaks on a feature branch
   don't take effect until they land on `develop`. Use `workflow_dispatch`
   against real merged/in-flight PRs post-merge to iterate.
2. Once satisfied, uncomment the `pull_request` trigger block in
   `ai-review.yml`.
3. In the same change, disable the Codex GitHub App's automatic reviews at
   <https://chatgpt.com/codex/settings/code-review> so PRs aren't
   double-reviewed.

## Required secrets

- `ANTHROPIC_API_KEY` — recommend a **dedicated, spend-capped, rotatable** key
  for this workflow rather than sharing the release-notes pipeline's key: this
  workflow runs against every PR (including, eventually, external ones via
  `/ai-review`) and posts model text into a public review, so its blast radius
  and cost profile differ from the release-notes use case.
- `OPENAI_API_KEY` — **must be added** before `codex-review` can run.

## Security model

- **Least privilege per job.** The top-level workflow grants no permissions
  (`permissions: {}`); each job requests only what it needs. `resolve` has
  `pull-requests: write` (see below) plus `contents: read`; `claude-review`/
  `codex-review` have read-only `contents` + `pull-requests`; only
  `post-review` has `pull-requests: write`.
- **`resolve` runs only trusted, default-branch code.** Its checkout is
  pinned to `${{ github.event.repository.default_branch }}`, never a PR's
  code, which is what makes it safe to also grant it `pull-requests: write` —
  used only for a best-effort 👀 reaction on the triggering comment (a
  reaction failure is logged and never fails the run).
- **Model jobs execute nothing from the PR head.** `claude-review` checks out
  the PR's own head commit into a separate `path: pr` — read-only review
  subject matter for Claude's `Read`/`Grep`/`Glob` tools — but every file it
  _executes_ (the prompt, `findings.schema.json`, the validation script, even
  the `bun-version-file` used to install the toolchain) comes from a second,
  separate checkout of the trusted default branch. Claude runs with `--bare`
  so it never auto-loads the PR head's own `CLAUDE.md`/`AGENTS.md` as
  instructions. The npm install of the Claude CLI runs with an isolated,
  pinned-registry npm config (`--userconfig /dev/null --globalconfig
/dev/null --registry=...`) so a PR-supplied `.npmrc` cannot redirect it.
  `codex-review` goes further and checks out no PR code at all — it works
  purely from `pr.diff` and `claude-findings.json` under `/tmp`, both
  regenerated from the GitHub API. Neither job can push, comment, or
  otherwise mutate anything.
- **Codex's sandbox.** `codex-review` sets `safety-strategy: drop-sudo`
  (removes sudo from the process running Codex — the action's own docs call
  out that a sudo-capable process can read secrets like `OPENAI_API_KEY` out
  of memory even under a read-only filesystem sandbox) together with
  `sandbox: read-only` (no filesystem writes, no network for Codex's own
  command execution). See the YAML comment on that step for the exact
  reasoning, verified against the pinned action's source.
- **Authorization for `/ai-review` requires repository write, not org
  membership.** `resolve.ts` always resolves the commenter's effective
  repository permission and requires `admin`/`write` — only the repository
  `OWNER` may skip that check. A read-only collaborator or an org member
  without push access cannot trigger a run. The command itself must match
  exactly: the comment's first line, trimmed, must be `/ai-review`
  (`/ai-reviewers`, `/ai-review-please`, etc. don't fire). The workflow's job
  `if:` also pre-filters cheaply on `author_association` as defense-in-depth,
  but `resolve.ts`'s checks are the actual gate.
- **The only write-capable job runs exclusively trusted code.**
  `post-review` checks out the base branch (`develop`) explicitly and never
  the PR head, so a malicious PR cannot smuggle a change into the one job
  that can write back to it.
- **Model text is sanitized before it's rendered.** `sanitizeModelText()`
  strips HTML comments (so injected diff content can't forge the hidden
  dedup/supersede markers) and neutralizes `@mentions`/`#issue-refs` in every
  model-provided string (`summary`, `claim`, `evidence`, `suggested_fix`,
  `adjudication.reason`) before it's posted.
- **Prompt-injection guards.** Both prompts explicitly instruct the model to
  treat the PR title, body, diff, code, and code comments as review subject
  matter, not instructions, and to ignore anything embedded in them that
  tries to alter findings, verdicts, or output format.
- **Advisory only.** The posted review always uses the `COMMENT` event —
  never `REQUEST_CHANGES` or `APPROVE` — so it can never itself block or
  fast-track a merge.
- **Not a required check, and never runs in `merge_group`.** This pipeline
  has no `pull_request`/`merge_group` trigger wired into branch protection;
  it is purely advisory input for reviewers.
- **Artifacts are short-retention and should be treated as published.** The
  `claude-findings` and `merged-review` artifacts (3-day retention) contain
  model output about a PR's code; treat them as visible to anyone with read
  access to the repository's Actions runs, same as the posted review itself.
