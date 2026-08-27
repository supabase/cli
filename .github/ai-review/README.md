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
- **`claude-review`** checks out the PR's own head commit (read-only tools,
  no write permissions, no secrets beyond `ANTHROPIC_API_KEY`) and asks
  Claude for one exhaustive pass, producing structured JSON findings
  validated against `findings.schema.json`.
- **`codex-review`** performs its own independent review of the diff, then
  adjudicates every Claude finding, merging both into one deduplicated,
  structured result validated against `merged-review.schema.json`.
- **`post-review`** (`.github/scripts/ai-review/post-review.ts`) is the only
  job with write access. It checks out the base branch (never the PR head),
  supersedes any prior AI review on the PR, and posts one `COMMENT`-event
  GitHub review with inline comments where the diff can anchor them and a
  summary body for everything else.

## Once-per-PR semantics and manual re-runs

New commits never re-trigger a review — `resolve.ts`'s dedup guard skips a
PR that already carries a review/comment with the `<!-- supabase-ai-review
-->` marker. To get another review on the same PR:

- an internal maintainer comments `/ai-review` on the PR, or
- run the workflow manually via `workflow_dispatch` with the PR number.

Both bypass the dedup guard and the draft/fork/bot skips (a human explicitly
asked), but still respect the size guard.

## Rollout

The pipeline currently runs only on-demand (`workflow_dispatch` or
`/ai-review`) — the `pull_request` trigger in the workflow is commented out
("shadow mode"). Rollout plan:

1. Run it manually against a sample of recent real PRs; tune the two prompts
   in this directory against what it actually produces.
2. Once satisfied, uncomment the `pull_request` trigger block in
   `ai-review.yml`.
3. In the same change, disable the Codex GitHub App's automatic reviews at
   <https://chatgpt.com/codex/settings/code-review> so PRs aren't
   double-reviewed.

## Required secrets

- `ANTHROPIC_API_KEY` — already configured (also used by the release-notes
  pipeline).
- `OPENAI_API_KEY` — **must be added** before `codex-review` can run.

## Security model

- **Least privilege per job.** The top-level workflow grants no permissions
  (`permissions: {}`); each job requests only what it needs. `resolve` reads
  PRs; `claude-review`/`codex-review` have read-only `contents`; only
  `post-review` has `pull-requests: write`.
- **Model jobs never get write access or PR-head-trusted secrets.**
  `claude-review` and `codex-review` check out the PR's own code — untrusted
  review subject matter — with zero write permissions, a read-only tool
  allowlist for Claude, and `safety-strategy: read-only` for Codex. Neither
  job can push, comment, or otherwise mutate anything.
- **The only write-capable job runs exclusively trusted code.**
  `post-review` checks out the base branch (`develop`) explicitly and never
  the PR head, so a malicious PR cannot smuggle a change into the one job
  that can write back to it.
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
