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

1. Lets Claude and Codex each do their own unhurried, exhaustive pass over the
   diff, **in parallel**.
2. Then a separate adjudicator (Codex) reconciles the two, verifying every
   finding by reading the real code (confirmed / refuted / uncertain) instead
   of taking either review at face value.
3. Posts ONE consolidated, deterministic review — no model call decides what
   gets posted or how; a plain TypeScript script does.

## Stages

```
                ┌─ claude-review ─┐
resolve  ──────>┤                 ├──> adjudicate ──> post-review
(decide)        └─ codex-review  ─┘   (Codex reconciles  (post ONE
              (two independent reviews  + verifies by      GitHub review)
               in parallel → JSON)      reading the code)
```

- **`resolve`** (`.github/scripts/ai-review/resolve.ts`) decides whether this
  run should happen at all. It applies the once-per-PR dedup guard, the
  automatic trigger's draft/bot/fork skips and author write-access gate, and
  authorization for manual `/ai-review` requests. There is no size cap: the models review
  agentically — reading the diff and the changed files via their own tools over
  many turns, like the local CLI — so PRs of any size are reviewed (very large
  diffs best-effort, within the model's context/turn budget). One caveat: the
  diff is fetched with `gh pr diff`, which GitHub itself caps (≈300 files /
  20k lines / 1 MB); a PR beyond those limits gets a truncated diff, so the
  review is truncated with it. Generating the diff from the base/head refs
  instead is a possible follow-up.
- **`claude-review`** and **`codex-review`** run **in parallel** — each gives
  its model an independent, exhaustive pass and produces structured JSON
  findings validated against `findings.schema.json`. Claude reads the PR's
  checked-out head commit; Codex reviews the diff.
- **`adjudicate`** checks out the PR head read-only, then runs Codex to
  reconcile the two finding sets — verifying each finding by **reading the real
  code**, merging duplicates (tagging `sources: claude | codex | both`), and
  preserving refuted findings with their reasons — into one result validated
  against `merged-review.schema.json`. Splitting this from the independent
  reviews lets those run concurrently and gives each job its own timeout.
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
asked).

## Automatic trigger

The `pull_request` trigger (`opened` / `ready_for_review`) is live. The
automatic path is **internal PRs only**: `resolve.ts` skips drafts, bots, and
fork PRs, and requires the PR author to hold effective repository **write
access** (`admin`/`write`, the same `WRITE_PERMISSIONS` gate as the manual
`/ai-review` path). A same-repo branch already implies the author could push,
so the permission lookup is defense-in-depth — it also catches access revoked
since the branch was pushed. External contributors' PRs are never reviewed
automatically; a maintainer comments `/ai-review` to request one.

Prompt/script tweaks take effect only once they land on `develop`: the
prompts, schemas, and validation script are read from a trusted checkout of
the _default branch_ (not the PR under review), and `post-review` checks out
`develop` explicitly. Use `workflow_dispatch` against real merged/in-flight
PRs post-merge to iterate.

The Codex GitHub App's automatic reviews must stay disabled at
<https://chatgpt.com/codex/settings/code-review> so PRs aren't
double-reviewed.

`merged-review.schema.json` uses `pattern` (on `category`) and `minItems` (on
`sources`); some OpenAI structured-output strict-mode implementations have
historically rejected those keywords. Both are redundant with the runtime
`assertMergedReview` validator in `post-review.ts`. If the first live Codex
run 400s on the output schema because of this, drop `pattern`/`minItems` from
`merged-review.schema.json` and rely on the validator alone.

## Required secrets

- `ANTHROPIC_API_KEY` — recommend a **dedicated, spend-capped, rotatable** key
  for this workflow rather than sharing the release-notes pipeline's key: this
  workflow runs against every PR (including, eventually, external ones via
  `/ai-review`) and posts model text into a public review, so its blast radius
  and cost profile differ from the release-notes use case. Model output is
  also secret-scrubbed before it's posted or uploaded (see below) as
  defense-in-depth, but the dedicated key is the real containment.
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
- **`bun` never runs with a cwd inside the untrusted `pr` checkout.** `bun`
  auto-loads `bunfig.toml` (whose `preload` runs arbitrary code) and `.env`
  from its cwd, so a `pr`-cwd `bun` invocation would let a PR-authored
  `pr/bunfig.toml` execute attacker code in a step holding
  `ANTHROPIC_API_KEY`. `claude-review`'s "Run Claude review" step keeps
  `working-directory: trusted` for the whole step and wraps only the `claude`
  invocation in a `( cd .../pr && claude ... )` subshell — `claude` is a
  standalone binary, not run via `bun`, so `bunfig.toml` never applies to it.
  Every `bun` process in the pipeline (`validate-findings`, `redact`,
  `validate-merged`, `post`) runs from a trusted checkout.
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
- **The automatic trigger requires the PR author to hold write access.**
  `resolve.ts` resolves the PR author's effective repository permission and
  requires `admin`/`write` before an automatic review runs, on top of the
  fork/draft/bot skips — so an external contributor's PR can never spend
  review budget or feed the models without a maintainer explicitly asking
  via `/ai-review`.
- **The only write-capable job runs exclusively trusted code.**
  `post-review` checks out the base branch (`develop`) explicitly and never
  the PR head, so a malicious PR cannot smuggle a change into the one job
  that can write back to it.
- **Model text is sanitized before it's rendered.** `sanitizeModelText()`
  redacts secret-shaped substrings (`redactSecrets()`; see below), strips HTML
  comments (so injected diff content can't forge the hidden dedup/supersede
  markers), and neutralizes `@mentions`/`#issue-refs` in every model-provided
  string (`summary`, `claim`, `evidence`, `suggested_fix`,
  `adjudication.reason`) before it's posted. `file` is separately validated at
  parse time (`assertFindings`/`assertMergedReview` reject a backtick,
  newline, control character, `<`, or a reserved marker string in it) and
  re-sanitized at every render site, since it's rendered inside `` `code` ``
  spans a plain string field otherwise couldn't safely occupy.
- **Model output is secret-scrubbed before it's posted or uploaded.**
  `redactSecrets()` replaces common credential shapes (Anthropic/OpenAI API
  keys, GitHub personal-access/app/OAuth/Actions tokens) with `«redacted»`;
  it's composed into `sanitizeModelText()` for the posted review, and the
  `redact <path>` subcommand applies it to `claude-findings.json`/
  `claude-raw.json`/`merged-review.json` in place before each is uploaded as
  an artifact. This is defense-in-depth against a prompt-injected model
  `Read`-ing a secret-bearing path (e.g. `/proc/self/environ`) and echoing a
  key back in a finding — the dedicated `ANTHROPIC_API_KEY` above is the real
  containment.
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
