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
root-owned. Effect lint covers `packages/stack`, all files under
`apps/cli/src/commands/experimental/stack` and `apps/cli/src/commands/experimental/compute`, the
shared `apps/cli/src/shared/compute` runtime helpers (excluding embedded starter templates), the
Compute test fixture helper, and `apps/cli/src/command-internal/experimental-feature.ts`,
`stack-backend.ts`, `stack-api.ts`, `stack-local-database.ts`, `stack-shadow.ts`, and
`postgres-client.run.ts`; use the root scripts for it.

### Config Naming Vocabulary

The config vocabulary is settled: `CliConfig` is the local config document, `ProjectConfig` is
the hosted-project subset, and `CliSettings` is CLI runtime settings. Use `Cli*` for local
checkout concepts and bare `Project*` for hosted concepts; helpers follow the family they serve.
Use a family-neutral name when a symbol deliberately spans both families. See the
[naming ADR](docs/adr/0020-config-naming-vocabulary.md) and
[config loading guide](packages/config/docs/cli-config-loading.md) for details, and
[config instructions](packages/config/AGENTS.md) for its separate release train.

## Effect

Effect V4 source is in `.repos/effect/`; use it instead of `node_modules`, with core APIs in
`.repos/effect/packages/effect/`, test helpers in `.repos/effect/packages/vitest/`, and migration
notes in `.repos/effect/MIGRATION.md`. Run `pnpm repos:install` if it is absent.

- Write new TypeScript runtime code in Effect. Internal helpers return Effects; Promise facades
  belong only at public edges. Wrap a foreign Promise once at its leaf with `Effect.tryPromise`,
  pass cancellation when supported, and map failures into typed domain errors.
- Effects are reusable: allocate mutable state per execution (`Effect.suspend`, `Effect.gen`, or
  scoped acquisition), and keep `Effect.sync` total by using `Effect.try` for throwing thunks.
- Keep service requirements visible through the type until composition. Provide services with
  layers or `Effect.provide`; do not hide missing services with casts, nested runtimes, globals,
  or synchronous adapters.
- Use `Scope`/`acquireRelease` for resources. Limit `uninterruptibleMask` to the
  acquisition-to-registration handoff and keep blocking acquisition interruptible with `restore`.
  Prefer `Effect.forkChild` or scope-owned fibers; detached work needs a documented lifetime and
  completion path. Use native `Deferred`, `Latch`, `Semaphore`, `Queue`, `PubSub`, `Schedule`,
  and race or concurrent combinators instead of waiter arrays, polling sleeps, or shared
  cancellation flags.
- Shared initialization and teardown are single-flight operations: callers join one cached
  Effect, fiber, or `Deferred<Exit<...>>`; interrupting one waiter must not cancel shared teardown.
- `Effect.callback` owns its full foreign lifecycle: register listeners before starting, resume at
  most once, and on cancellation remove owned listeners and close or destroy the exact resource.
- Expected failures use typed `Data.TaggedError` and `Effect.fail`; never throw them inside Effect
  programs. Defects are impossible invariants. Recover with the narrowest `catch` operator; use
  `catchCause` only when recovery intentionally handles defects or interruption, preserve every
  other cause, and do not use operational `orDie`/`Layer.orDie`.
- Preserve `Data.TaggedError` string identities in `apps/cli/src` and `packages/config/src` when
  renaming classes; class names may change, but tags must remain stable. See the CLI
  [telemetry identity rule](apps/cli/AGENTS.md#telemetry).
- Use public helpers (`Exit.isSuccess`, `Option.isSome`, `Cause.isTimeoutError`, and similar) and
  exhaustive `Match`/predicate helpers for domain variants. Raw `._tag` is for schema/type
  definitions, serialization, or genuinely dynamic boundaries only.
- Compose schemas with `decodeUnknownEffect`, `decodeEffect`, and `encodeEffect`, mapping
  `SchemaError` into domain errors. Sync codecs are acceptable only at an explicitly synchronous,
  service-free edge that intentionally throws.

### Effect linting

- Fix the underlying design when Effect lint reports a violation. Refactor to native
  Effect constructs; do not silence findings with `oxlint-disable`, casts, file
  exclusions, or weaker lint configuration.
- A suppression is acceptable only for a demonstrated false positive or an unavoidable
  foreign-library boundary. Before retaining one, inspect the corresponding Effect API
  and identify the specific missing capability or behavior that prevents replacement;
  existing Promise-based code, native API usage, or refactoring effort alone do not
  justify an exception. Limit it to the specific rule and smallest scope, and explain
  why a compliant implementation is not possible.
- Passing lint by bypassing its rules does not complete an Effect migration.

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
handlers and feature matrices with realistic Effect layers, and reserve E2E for one to three
golden-path subprocess workflows. Handler integration is the default for command behavior. Use
`@effect/vitest`'s `it.live` with stateful mock factories returning `{ layer, state }`;
assert resulting state and user-visible behavior, not `vi.fn()` call details. See
[`login.integration.test.ts`](apps/cli/src/commands/login/login.integration.test.ts) and
[`login.e2e.test.ts`](apps/cli/src/commands/login/login.e2e.test.ts); E2E uses
[`tests/helpers/cli.ts`](apps/cli/tests/helpers/cli.ts) and `runSupabase()`.

Keep tests flake-resistant:

- Subscribe before triggering a transition; use observable readiness/completion, never sleeps or polling delays for propagation, startup, cancellation, cleanup, or port release. Timeouts are guards; use TestClock or fake timers for timing semantics.
- Assume file-level parallelism: use unique IDs, roots, process markers, and derived resources; never disable parallelism globally.
- Never release and reuse an ephemeral port or assume a released endpoint is a dead backend; own a refusal listener or inject the failure.
- Require subprocess readiness and stdout/stderr diagnostics; clean up only exact owned resources. Reproduce and stress flake fixes, then repeat the green case.

## Maintaining instructions

Add instructions only for recurring mistakes or non-obvious repository constraints. Update an
existing rule before adding another; prefer links to maintained sources over copied examples.
