# Supabase

Bun monorepo with workspaces under `apps/` and `packages/`. `pnpm` is the package manager; use
`pnpm <script>`, never `bun run` or `npm run`.

## Workspaces and naming

- `apps/cli` — published `supabase` CLI
- `apps/docs` — Next.js docs site
- `packages/api` — typed Management API client
- `packages/config` — published config schema and generated types
- `packages/stack` — local Supabase stack runtime
- `packages/cli-*` — published platform binary wrappers

Use an existing TypeScript/Bun workspace, especially `packages/api`, as the package-structure
reference. Published `apps/cli` and `packages/config` are not private; `apps/docs` and
`packages/cli-*` have their own shapes. Generic lint, format, and unused-code tooling is
root-owned.

### Config Naming Vocabulary

The config vocabulary is settled: `CliConfig` is the local config document, `ProjectConfig` is
the hosted-project subset, and `CliSettings` is CLI runtime settings. Use `Cli*` for local
checkout concepts and bare `Project*` for hosted concepts; helpers follow the family they serve.
Use a family-neutral name when a symbol deliberately spans both families. See the
[naming ADR](docs/adr/0020-config-naming-vocabulary.md) and
[config loading guide](packages/config/docs/cli-config-loading.md) for details, and
[config instructions](packages/config/AGENTS.md) for its separate release train.

## Effect

Always use the [Effect skill](.agents/skills/effect/SKILL.md) when writing or changing code. Read
the references relevant to the task before editing. Write
all TypeScript runtime code in Effect. Promise-returning APIs are allowed only as package exports
for consumers that do not use Effect.
The skill is authoritative for Effect coding practices when repository instructions conflict.

Effect linting uses oxlint via `.oxlintrc.effect.json`; run `pnpm lint:effect:check` or
`pnpm lint:effect:fix` from the repository root.

## Commands, validation, and workflows

Package scripts are the source of truth for leaf workspaces; root-owned Turbo coordinates build,
generation, quality, live, and auxiliary workflows. Inspect dependencies with
`pnpm exec turbo run <task> --dry=json`.

Keep the local feedback loop fast; full CI runs for ready PRs targeting `develop`.

- Documentation-only edits need formatting and reference checks. Code changes need relevant
  type/lint checks and affected unit/integration tests, using package scripts and root-owned tools.
- Before pushing, run formatting and applicable lint checks on all changed files and fix any
  findings in those files.
- Broaden checks when shared behavior or runtime wiring changes warrant it, or when requested.
  Run targeted E2E when the subprocess boundary matters; run full E2E only on explicit request.
- Repeat checks only after changes or failures that could affect their result.
- Fix failures caused by the change and report any unresolved validation blockers. Investigate
  unexpected failures without automatically expanding the task into unrelated repairs.

Use `pnpm test` only when its scope fits the change; the CLI's aggregate script includes full E2E,
so use `pnpm run test:unit` and `pnpm run test:integration` with affected test files locally.
When repo-wide validation is warranted, use root `pnpm check:all` or `pnpm fix:all`. These are the
repo-wide quality entrypoints: `check:all` runs generic and Effect lint, format, knip, and type
checks; `fix:all` applies generic and Effect lint, format, and knip fixes. Do not use production
`as` casts to silence type errors.

Use root Turbo entrypoints for live and auxiliary workflows:

```sh
pnpm run build
pnpm run generate
pnpm exec turbo run supabase#build
pnpm run test:live
```

## Comments

Comments exist for the next reader, not as the author's audit trail. Code states what happens; a
comment states only the why that the code cannot carry. Most code needs no comment at all.

### When to comment

Write a comment only for an invariant or constraint the types cannot express, an external quirk,
a decision that would otherwise read as a bug, or a pointer to an ADR, `SIDE_EFFECTS.md`, docs
page, or upstream issue. If the rationale needs more than three lines, move it to documentation.

### How to comment

- Prefer one sentence of JSDoc on exported symbols; use tags such as `@deprecated` and `@see` when they carry useful meaning.
- Skip JSDoc on self-explanatory internal helpers and keep inline comments to one or two lines.
- Describe behavior in its own terms and in the present tense.
- Published package exports need a one-line JSDoc summary. This public repository must not include internal context in comments.

### Never write

- Code narration, provenance/history, evidence trails, ticket IDs as provenance, or meta-commentary on code shape. A ticket ID belongs only in a `TODO(CLI-1234):` or when no ADR exists and the ticket is the only home for a decision.
- Restatements of docs, section banners, or Go-parity framing. Link to maintained docs instead.
- ALL-CAPS emphasis or words such as “deliberately”, “crucially”, and “exactly”.

Tests should carry intent in their names; comments only explain non-obvious fixture setup. Keep
tool directives and tool-facing JSDoc tags, and give every lint disable a short reason after `--`.
A source file whose comment lines exceed a quarter of its code lines should move prose into docs.

## Pull requests

Use conventional-commit titles: `<type>(<scope>): <subject>`. Valid scopes are listed in
[`commitlint.config.js`](commitlint.config.js); keep its list synchronized with the mirrored
scope list in [the PR lint workflow](.github/workflows/lint-pull-request.yml). Non-release changes use `chore`, `docs`, `test`,
or `ci` rather than release-triggering types. Do not put validation,
test plans, or check lists in PR descriptions. Public PRs, issues, and code comments must omit
internal metrics (percentages, ratios, or relative changes are fine), vendor/legal/pricing/strategy
details, and competitor names; protocol identifiers such as user-agent strings are fine. Keep
internal context in Linear.

## Refactoring

Internal unreleased APIs may be simplified or reshaped; move responsibility to the correct owner
and delete obsolete helpers, shims, and parallel paths instead of preserving compatibility
scaffolding. Protect shipped interfaces and valuable persistent data; update consumers, tests, and
docs when interfaces, ownership, or lifecycle changes.

## Test quality

- Write focused tests that read as stories: arrange, act, assert.
- Assert behavior that matters to consumers, not implementation details. Prefer real parsers and observable outcomes over source-text or registry checks.
- Make assertions meaningful: establish prerequisites, check specific failures, and choose matchers that express the intended contract.
- Keep setup concise with small fixtures. Accept some duplication rather than introducing unnecessary test abstractions.
- Remove redundant coverage. Push back on review suggestions that add assertions without protecting meaningful behavior.

Name tests `*.unit.test.ts`, `*.integration.test.ts`, or `*.e2e.test.ts`; colocate them with source.
Use `tests/` for shared helpers. For CLI commands, unit-test complex pure logic, integration-test
handlers and feature matrices with realistic dependencies, and reserve E2E for one to three
golden-path subprocess workflows. Handler integration is the default for command behavior. Assert
resulting state and user-visible behavior, not mock call details. See
[`login.integration.test.ts`](apps/cli/src/commands/login/login.integration.test.ts) and
[`login.e2e.test.ts`](apps/cli/src/commands/login/login.e2e.test.ts); E2E uses
[`tests/helpers/cli.ts`](apps/cli/tests/helpers/cli.ts) and `runSupabase()`.

Keep tests flake-resistant:

- Subscribe before triggering a transition; use observable readiness/completion, never sleeps or polling delays for propagation, startup, cancellation, cleanup, or port release. Timeouts are guards; use controlled clocks or fake timers for timing semantics.
- Assume file-level parallelism: use unique IDs, roots, process markers, and derived resources; never disable parallelism globally.
- Never release and reuse an ephemeral port or assume a released endpoint is a dead backend; own a refusal listener or inject the failure.
- Require subprocess readiness and stdout/stderr diagnostics; clean up only exact owned resources. Reproduce and stress flake fixes, then repeat the green case.

## Maintaining instructions

Add instructions only for recurring mistakes or non-obvious repository constraints. Update an
existing rule before adding another; prefer links to maintained sources over copied examples.
