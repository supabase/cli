# OpenAPI Sync Workflows

> Extracted from [ADR 0005](adr/0005-openapi-driven-code-generation.md). This document covers the GitHub Actions workflows that keep checked-in OpenAPI types in sync with the live Management API. For the three-layer generation strategy and architectural decisions, see the ADR.

Three GitHub Actions workflows keep the checked-in `v1.d.ts` in sync with the live Management API spec across the private API repo and the public CLI repo.

## 1. Sync workflow (CLI repo — `.github/workflows/openapi-sync.yml`)

Triggered by three events:

- **`repository_dispatch`** (`openapi-spec-changed`) — pushed from the API repo after production deploy
- **`schedule`** (daily cron) — fallback in case a dispatch is lost
- **`workflow_dispatch`** — manual trigger for debugging or ad-hoc sync

Steps:

1. Check out the CLI repo
2. Install dependencies (`bun install --frozen-lockfile`)
3. Regenerate types (`bun run generate` — runs `openapi-typescript` against the live spec URL)
4. Check `git diff --exit-code packages/api/src/v1.d.ts` — if unchanged, exit early (no PR)
5. Run quality gates: `bun run ts:check`, `bun run lint`, `bun run fmt:check`, `bun run knip`
6. Open or update a PR via `peter-evans/create-pull-request` with:
   - **`add-paths`** restricted to `packages/api/src/v1.d.ts` — prevents accidental lockfile or unrelated changes from being committed
   - **Branch**: `chore/openapi-sync`
   - **Labels**: `automated`, `api-types`

Concurrency:

```yaml
concurrency:
  group: openapi-sync
  cancel-in-progress: true
```

This ensures at most one sync PR exists at any time — a new dispatch cancels any in-flight run and supersedes the previous PR.

## 2. Verify workflow (CLI repo — `.github/workflows/openapi-verify.yml`)

Scheduled twice weekly (e.g., Tuesday and Friday). Acts as a safety net for silent dispatch failures.

Steps:

1. Check out the CLI repo
2. Install dependencies
3. Regenerate types (`bun run generate`)
4. Run `git diff --exit-code packages/api/src/v1.d.ts`
5. **Fail the workflow** if the checked-in types don't match what `openapi-typescript` produces

This workflow does **not** open a PR — it only alerts. If it fails, a developer triggers the sync workflow manually or investigates why dispatches stopped arriving.

## 3. Sender workflow (API repo, private — `.github/workflows/notify-cli.yml`)

Fires after a production deploy completes, using `workflow_run` as the trigger (so it runs only after a successful deploy, not on every push).

Steps:

1. Generate a short-lived installation token via `actions/create-github-app-token@v1` scoped to the CLI repo
2. Dispatch the `openapi-spec-changed` event to the CLI repo via `peter-evans/repository-dispatch`

```yaml
- uses: actions/create-github-app-token@v1
  id: app-token
  with:
    app-id: ${{ secrets.SYNC_APP_ID }}
    private-key: ${{ secrets.SYNC_APP_PRIVATE_KEY }}
    repositories: "cli"

- uses: peter-evans/repository-dispatch@v3
  with:
    token: ${{ steps.app-token.outputs.token }}
    repository: supabase/cli
    event-type: openapi-spec-changed
```

**Why a GitHub App instead of a PAT**: GitHub App installation tokens are short-lived (~1 hour), scoped to specific repositories, and don't tie permissions to a personal account. A long-lived PAT would need to be rotated manually and grants broader access than necessary.

## Design Decisions

- **Change detection via `git diff`** — comparing the regenerated file against what's checked in is simpler and more robust than tracking spec hashes or ETags across repos. If the output is byte-identical, there's nothing to do.
- **`add-paths` restriction** — `peter-evans/create-pull-request` commits everything that changed in the working tree by default. Restricting to `v1.d.ts` prevents accidental lockfile updates or unrelated diffs from leaking into the sync PR.
- **Concurrency group with `cancel-in-progress`** — if the API deploys twice in quick succession, only the latest sync matters. The concurrency group ensures the first run is cancelled, avoiding duplicate PRs.
- **Verify as a separate workflow** — decoupling verification from sync keeps failure signals clean. A verify failure means "types are stale", not "the PR couldn't be created".
