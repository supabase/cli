# Supabase

Bun monorepo with workspaces under `apps/` and `packages/`.

## Package Manager

`pnpm` is the package manager. Use `pnpm <script>` to run scripts from any `package.json`. Do not use `bun run` or `npm run`.

## Workspace Layout

- `apps/cli` — main `supabase` package
- `apps/docs` — internal Next.js docs site
- `packages/api` — typed Supabase Management API client
- `packages/config` — config schema and generated types
- `packages/process-compose` — process orchestration library
- `packages/stack` — programmatic local Supabase stack runtime
- `packages/cli-*` — platform-specific published CLI binary wrappers

## Package Structure

Use `packages/process-compose` as the reference for internal TypeScript/Bun workspaces such as `apps/cli`, `packages/api`, `packages/config`, `packages/process-compose`, and `packages/stack`.

These workspaces should generally follow this structure:

**package.json:**

- `name`: `@supabase/<package-name>`
- `type`: `"module"`
- Standard scripts: `test`, `types:check`
- Standard devDependencies: `@tsconfig/bun`, `@types/bun`, `typescript`

Generic linting (`oxlint`), formatting (`oxfmt`), and unused-code analysis (`knip`) are repo-wide, not per-package: the tools are root devDependencies configured by `.oxlintrc.json`, `.oxfmtrc.json`, and `knip.json` at the repo root (knip's config maps each workspace under its `workspaces` key). Effect-specific linting is incrementally scoped to `packages/stack` and `packages/process-compose` through `.oxlintrc.effect.json`; run it with the root `lint:effect:check` or `lint:effect:fix` scripts. The root `check:all`/`fix:all` scripts are the sole repo-wide quality entrypoints and use Turbo to orchestrate the root-owned generic `lint:*`/`fmt:*`/`knip:*` scripts and package `types:check` targets; `fix:all` runs the Effect lint fix after those generic fixes complete. Package-local work can run `pnpm types:check` and the package's test scripts; `pnpm exec oxlint`, `pnpm exec oxfmt`, and `pnpm exec knip-bun` from the repo root also work directly.

Expected exceptions:

- `apps/cli` is published, so it is not `private`
- `apps/docs` is a Next.js app and does not follow the standard package template
- `packages/cli-*` are binary wrapper packages and do not follow the standard TypeScript workspace template

**tsconfig.json:**

```json
{
  "extends": "@tsconfig/bun/tsconfig.json"
}
```

## Config Naming Vocabulary

`@supabase/config` and its CLI consumer use three settled names:

- `CliConfig` — the full config-file document (`supabase/config.toml`/`.json`), the local superset
  including local-only sections.
- `ProjectConfig` — the hosted-project subset: a sparse overlay of the hosted sections (api, auth,
  db, realtime, storage, workers, experimental) describing what a Supabase project looks like on
  the platform.
- `CliSettings` — the CLI's own runtime settings (platform `apiUrl`, access token, telemetry flags,
  `supabaseHome`, …), owned by `apps/cli`.

Use the `Cli*` prefix for the local checkout side and a bare `Project*` name for the hosted
Supabase project. Config-value helpers follow the config family regardless of their inputs (e.g.
`resolveCliConfigValue`, `CliConfigParseError`). A symbol that deliberately spans both
families takes a family-neutral name instead of a misleading prefix (see the ADR 0020 addendum for
the `EffectiveConfig` precedent).

See [`docs/adr/0020-config-naming-vocabulary.md`](docs/adr/0020-config-naming-vocabulary.md) and
[`packages/config/docs/cli-config-loading.md`](packages/config/docs/cli-config-loading.md) for the
full vocabulary.

## Effect

The complete source code for the `effect` library (V4) is in `.repos/effect/`. Study types, APIs, and patterns there instead of `node_modules/`.

If `.repos/effect/` is missing in a fresh clone, run this from the repo root first:

```sh
pnpm repos:install
```

Key references:

- `.repos/effect/packages/effect/` — core `effect` library
- `.repos/effect/packages/vitest/` — `@effect/vitest` test helpers
- `.repos/effect/MIGRATION.md` — V3 to V4 migration guide

### Effect-native by default

Write new runtime code Effect-native from the start; do not build a sync or Promise-based core and wrap it in Effect afterwards. Retrofitting Effect onto a Promise core is expensive and error-prone: it resurfaces as blocking waits where a `Schedule` belongs, interruption gaps around resource acquisition, and untyped failures leaking through `Effect.tryPromise`.

- Model failures as `Data.TaggedError` classes with typed error channels, dependencies as services provided through `Layer`, retries/polling as `Schedule`s, and resource lifecycles with scopes and interruption-safe masks — never `Atomics.wait`, ad-hoc `setTimeout` loops, or manual try/finally resource juggling in core code.
- Expose Promise-based facades only at the outermost package edge (public entrypoints for non-Effect consumers), acquired asynchronously — never inside the core.
- Internal helpers must not return Promises. Use the Effect platform services or
  `Effect.callback` for filesystem, process, network, and other host APIs. A
  foreign library operation that exposes only a Promise may be wrapped once
  with `Effect.tryPromise` at the leaf boundary, with its cancellation signal
  and failure mapped into Effect. Any other exception needs a concrete reason
  why the operation is impossible to express with Effect.

### Effect evaluation and state

An `Effect` is a reusable description and may be evaluated more than once.

- Create per-execution mutable state inside `Effect.suspend`, `Effect.gen`, or a
  scoped acquisition.
- Never allocate mutable ownership state while constructing an Effect and then
  close over it. Re-evaluating that Effect would share state across executions.
- Keep `Effect.sync` total. If its thunk can throw, use `Effect.try` and map the
  failure into the typed error channel.

### Foreign callback boundaries

An `Effect.callback` adapter owns the complete lifecycle of the foreign
operation.

- Register success, error, abort, close, and cancellation listeners before
  starting the operation.
- Guarantee at-most-once resumption.
- Return a cancellation effect that removes every owned listener and closes or
  destroys the exact owned resource.
- Pass the Effect cancellation signal to foreign Promise APIs whenever they
  support `AbortSignal`.

### Service requirements

Let Effect service requirements remain visible until the composition boundary.

- Propagate `FileSystem`, `Scope`, process, network, and other requirements
  through the Effect type.
- Provide services through layers or explicit `Effect.provide` at the owning
  boundary.
- Do not hide missing services with casts, nested `runSync`/`runPromise`,
  globals, or ad-hoc synchronous adapters.

### Structured concurrency and coordination

Use Effect's concurrency primitives according to the ownership relationship they
represent:

- Prefer `Effect.forkChild`; use `forkScoped`/`forkIn` when a fiber belongs to a
  longer-lived scope. `forkDetach` is exceptional and must document why the
  work intentionally outlives its caller and how completion is observed.
- Use `Deferred` for one-shot handoff, `Latch` for a reusable open/closed gate,
  `Semaphore` for bounded access or lifecycle serialization, `Queue` for
  producer/consumer work, and `PubSub` for broadcast. Do not replace these with
  mutable waiter arrays, Promise gates, booleans plus polling, or propagation
  sleeps.
- Use the `concurrency` option on `Effect.all`/`Effect.forEach` for simple caps;
  use a `Semaphore` when permits span a larger critical section.
- Let `Effect.race`, `raceFirst`, and concurrent combinators interrupt their
  losing or sibling fibers. Do not hand-roll cancellation through shared flags.
- Own resources with `Scope`, `acquireRelease`, or scoped layers. Restrict
  `uninterruptibleMask` to the acquisition-to-registration handoff and keep the
  actual blocking acquisition interruptible with `restore`.
- Use `Schedule` for retry and unavoidable polling policy. Prefer observable
  signals (`Deferred`, streams, filesystem/process events) whenever the foreign
  API exposes them.

### Shared initialization and teardown

Concurrent callers must join one owned operation rather than merely observe a
boolean.

- Represent single-flight initialization and teardown with a cached Effect, a
  shared Fiber, or a `Deferred<Exit<...>>`.
- The owning fiber performs the work; every caller awaits the same result.
- Interrupting one waiter must not cancel shared teardown or leave later
  callers believing cleanup has completed.

### Typed failures and tagged values

Expected failures in Effect code must be represented in the typed error channel.

- Use `Data.TaggedError` for domain failures and return them with `Effect.fail`.
- Do not `throw` expected validation, parsing, protocol, filesystem, or lifecycle errors inside Effect programs.
- Use `Effect.try`, `Effect.tryPromise`, or callback adapters only at foreign boundaries, and map failures into a declared domain error.
- Reserve defects (`Effect.die` or an uncaught throw) for genuinely impossible internal invariants and programmer bugs.
- Standalone process entrypoints and public non-Effect adapters may throw or reject after translating the typed Effect failure at the outer boundary.

### Causes and recovery

Use the narrowest error operator that matches the intended recovery policy.

- `Effect.catch`, `catchTag`, and `catchTags` handle expected typed failures.
- Use `Effect.catchCause` only when recovery intentionally needs to observe
  defects or interruption.
- When inspecting a full `Cause`, recover only the explicitly recognized
  condition and return every other cause unchanged with `Effect.failCause`.
- Never squash an arbitrary cause and convert it into a domain error; that can
  erase interruption and defects.
- Avoid `Effect.orDie` and `Layer.orDie` for operational failures that callers
  may need to classify, retry, or report.

Do not inspect Effect runtime representations through fields such as `._tag`.

- Use the library helper for Effect data types: `Exit.isSuccess`, `Exit.isFailure`, `Option.isSome`, `Option.isNone`, `Result.isSuccess`, `Result.isFailure`, `Cause.isTimeoutError`, and similar APIs.
- Use `Effect.catchTag`, `Effect.catchTags`, `Effect.tapErrorTag`, and related operators for typed Effect errors.
- Use `Predicate.isTagged` or a named domain predicate when narrowing one variant of a tagged domain union.
- Use `Match.tag`, `Match.valueTags`, or another exhaustive `Match` helper when behavior depends on multiple variants of a domain union.
- Direct `_tag` access is appropriate only when defining schemas/types, constructing or serializing tagged values, or implementing a genuinely dynamic boundary that cannot know the variants statically.
- Tests follow the same rules; assertions should use public helpers rather than inspecting Effect internals.

Prefer exhaustive matching for domain state machines and event handling. A new union member should produce a type error at every behaviorally relevant match rather than silently falling through a `default` branch.

### Schema decoding and encoding

Inside Effect code, compose schemas through their Effect APIs:

- Prefer `Schema.decodeUnknownEffect`, `Schema.decodeEffect`, `Schema.encodeEffect`, and their typed error channels.
- Map `SchemaError` into the domain error expected by the consuming operation.
- Express additional validation with `Effect.filterOrFail`, `Effect.flatMap`, or `Effect.fail` instead of throwing inside a decoding callback.
- Avoid `decodeUnknownSync` and `encodeUnknownSync` in Effect-native code. They execute through the synchronous runtime and report invalid input by throwing, which can turn a recoverable parse failure into a defect.
- Sync schema operations are not asynchronous I/O and are not inherently “blocking” in that sense. The reason to prefer the Effect variants is typed failure handling, dependency propagation, interruption semantics, and support for effectful schema transformations—not to move ordinary CPU validation onto another thread.
- Sync codecs are acceptable at an explicitly synchronous outer boundary when the schema is guaranteed to be service-free and the caller intentionally accepts a thrown exception. Otherwise, keep decoding and encoding in Effect.

## Code Quality

Never `git commit` or `git push` until lint and `types:check` have been run and passed for the change. Targeted unit/integration tests are not a substitute — CI Check code quality runs `pnpm check:all` (`types:check`, oxlint, oxfmt, knip). Before commit or push, from each changed TypeScript workspace run `pnpm types:check`, and from the repo root run `pnpm exec oxlint` (or `pnpm check:all`). If those fail, fix them before committing.

Run repo-wide quality checks from the repository root with `pnpm check:all` or `pnpm fix:all`; these root scripts are the only quality entrypoints and delegate orchestration to Turbo. For package-local work, run `pnpm types:check` and the applicable package test scripts from the workspace you changed. Do not consider a task complete until all relevant scripts pass.
Do not waive or defer failing checks in a changed workspace as "pre-existing". If a required check fails, fix it before closing the task. Only treat a failure as an external blocker when it cannot be resolved within the workspace, and in that case call it out explicitly.
If you run a root quality command such as `pnpm check:all`, you own all failing checks it reports for the duration of the task, even if the failing files look unrelated. Do not leave the repository with unresolved failing checks after running the command.
Do not use TypeScript `as` casts to silence type errors in production code. If a type does not line up, fix the typing or restructure the code until it type-checks cleanly.

From the repository root:

```sh
pnpm check:all
pnpm fix:all
```

From a changed package workspace:

```sh
pnpm types:check
pnpm test
```

If a workspace exposes a different script set, use that workspace's `package.json` as the source of truth.

## Workspace graph and task execution

This repo uses pnpm workspaces and Turbo for task execution and dependency
graph orchestration. Package scripts are the source of truth for leaf
implementations; root-owned Turbo tasks coordinate build, generation, quality,
live, and auxiliary workflows. Inspect a task's dependency graph with Turbo's
JSON dry-run output:

```sh
pnpm exec turbo run <task> --dry=json
```

### Running repository workflows

```sh
# Build all migrated workspaces and their dependencies
pnpm run build

# Generate API, then documentation artifacts
pnpm run generate

# Build only the CLI and its Go sidecar
pnpm exec turbo run supabase#build

# Run the live CLI suite
pnpm run test:live
```

Run live and auxiliary workflows through their root Turbo entrypoints, and run
ordinary tests with the relevant package's declared `pnpm test` scripts. Repo-
wide quality checks use the repository-root `pnpm check:all` and `pnpm fix:all`
scripts, which delegate orchestration to Turbo.

## Pull Requests

PR titles must follow conventional-commits format because the `Lint Pull Request` workflow runs `amannn/action-semantic-pull-request` against the title. Use `<type>(<scope>): <subject>` (e.g. `fix(cli): …`, `test(cli): …`, `feat(api): …`). A bare descriptive title like "Build TypeScript CLI as compiled Bun binaries" will fail the lint. When a PR is created (including by the Claude Code UI or someone else), check the title against this rule and update it if needed.
Avoid semantic-release-triggering types for non-release changes. For CI, docs, tests, tooling, agent instructions, and other repository-maintenance changes, do not use `fix`, `feat`, `perf`, or breaking-change markers just to satisfy the PR title linter. Prefer non-releasing conventional types such as `chore`, `docs`, `test`, or `ci` when the change should not produce a package release.
Do not include a validation, test plan, or list of checks in PR descriptions. CI enforces validation for PRs, so PR descriptions should focus on what changed, why it changed, and any reviewer-relevant context that CI cannot infer.
This repo is public: PR descriptions, issues, and code comments are world-readable. Keep internal content out of them: absolute production metrics (event counts, user counts, revenue figures: state percentages, ratios, or relative change instead), internal decision detail (vendor, legal, pricing, or strategy discussions), and competitor names (protocol identifiers such as user-agent strings are fine). Put that context in the Linear issue and link it.

## Refactoring Policy

None of this code is published as a stable internal platform API, so backward compatibility is not a constraint. Prefer the simplest correct design, including substantial refactors, API reshaping, and deleting obsolete code when it improves the codebase.
When a cleaner architecture is available, prefer moving responsibilities to the correct owner over layering callbacks, adapters, or transitional state into an existing facade.
Do not preserve inaccurate, leaky, or compromise-driven internal APIs just to avoid updating call sites in the same change.
Delete obsolete helpers, shims, and parallel code paths as part of the refactor instead of leaving compatibility scaffolding behind.
When a refactor changes ownership, interfaces, or lifecycle boundaries, update the relevant tests and docs in the same task.

## Testing

See `apps/cli/src/commands/login/` as the canonical example.

### File naming

- `*.unit.test.ts` — unit tests, colocated next to source
- `*.integration.test.ts` — integration tests, colocated next to source
- `*.e2e.test.ts` — end-to-end tests, colocated next to source
- `tests/` — shared test helpers (for example `tests/helpers/cli.ts`)

### Testing pyramid for CLI commands

1. **Unit tests** on `lib/` — reserved for pure logic and complicated algorithms that benefit from very tight, fast coverage
2. **Integration tests** on handlers — the default place for almost all command behavior, including parsing, normalization, output shaping, fallback behavior, error mapping, and feature matrix coverage, with mocked Effect services via `Layer.succeed`
3. **E2e tests** — a very small golden-path surface only, usually 1 to 3 tests for the most critical subprocess/runtime workflows

### E2e scope policy

- Treat e2e coverage as scarce and expensive. Keep it focused on the most critical user workflows and happy-path smoke coverage.
- Prefer integration tests for everything that does not require a real subprocess, real runtime wiring, or real cross-boundary behavior.
- Do not use e2e tests for help text, argument normalization, dry-run payloads, schema rendering, projection formatting, or similar detail coverage unless the real subprocess boundary itself is the thing being validated.
- If an assertion can be expressed faithfully in an integration test, it should generally live there instead of in e2e.
- When in doubt, move coverage down the pyramid: e2e -> integration -> unit.

### Test execution policy

- Always run unit and integration tests for the workspace you changed before considering the task done.
- Do not automatically run the full e2e suite as part of the normal feedback loop.
- Run e2e tests only when the user asks for them, or when you specifically need them for the command you touched.
- When you do run e2e tests automatically, run only the targeted e2e file(s) for the command you changed, not unrelated e2e tests.

### Flake-resistant tests

Tests must remain correct under file-level parallelism and slow or loaded CI. Synchronize on observable conditions—never use `Effect.sleep`, `setTimeout`, or polling delays for propagation, startup, cancellation, cleanup, or port release. Subscribe before triggering the transition, then await a `Deferred`, stream, fiber, readiness result, file, or state change. Timeouts are guards, not sub-second correctness assertions; use TestClock or fake timers for timing semantics. Assume files run concurrently: use unique IDs, roots, process markers, and derived resources, while intentional collisions stay within one test. Never bind an ephemeral port, close it, and reuse it as a reservation; never use a released endpoint as a guaranteed dead backend—own a reset/refusal listener or inject the failure. Subprocesses need explicit readiness plus stderr/stdout diagnostics. Cleanup must target only exact owned PIDs, tokens, paths, names, and labels; never machine-wide prefix or command snapshots, and never globally disable parallelism. For flake fixes, reproduce/stress the red case and repeat the green case.

During review, arbitrary sleeps, wall-clock completion assertions, released-port reuse, static cross-file identities, and broad cleanup are blocking unless intrinsic to the behavior and documented.

### Integration test pattern

Uses `@effect/vitest` with `it.live` — stateful mock factories return `{ layer, state }`. Avoid `vi.fn()` spies; assert on accumulated state after the effect runs:

- Integration tests for CLI commands should be high-level and scenario-oriented.
- Prefer realistic user flows and user-intent test names over implementation-branch test names.
- Assert primarily on user-visible behavior and resulting state, not on internal call ordering.
- Use command-scoped setup helpers that return `{ layer, out, ...state }` so the tests read like command scenarios instead of DI assembly.
- If a test is mostly validating a pure transformation, formatter, schema descriptor, or other implementation detail, it should usually be a unit test instead.

```ts
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";

function mockCredentials(opts: { existingToken?: string } = {}) {
  let savedToken: string | undefined;
  return {
    layer: Layer.succeed(Credentials, {
      getAccessToken: Effect.sync(() => opts.existingToken ?? savedToken),
      saveAccessToken: (token: string) =>
        Effect.sync(() => {
          savedToken = token;
        }),
    }),
    get savedToken() {
      return savedToken;
    },
  };
}

function setupTty(opts = {}) {
  const creds = mockCredentials(opts);
  const out = mockOutput(opts);
  const api = mockApi(opts);
  const layer = Layer.mergeAll(emptyEnv(), api.layer, creds.layer, mockCrypto(), ...);
  return { layer, creds, out, api };
}

it.live("saves the token on login", () => {
  const { layer, creds, out } = setupTty();
  return Effect.gen(function* () {
    yield* login(args);
    expect(creds.savedToken).toBe(VALID_TOKEN);
    expect(out.messages).toContainEqual(
      expect.objectContaining({ type: "success", message: "Logged in successfully." }),
    );
  }).pipe(Effect.provide(layer));
});

it.live("fails with SomeError", () => {
  const { layer } = setupTty();
  return Effect.gen(function* () {
    const exit = yield* myEffect(args).pipe(Effect.exit);
    expect(Exit.isFailure(exit)).toBe(true);
  }).pipe(Effect.provide(layer));
});
```

### E2e test pattern

Use the `runSupabase()` helper from `tests/helpers/cli.ts`, which spawns a real CLI subprocess with an isolated temp HOME:

```ts
import { describe, expect, test } from "vitest";
import { runSupabase } from "../../tests/helpers/cli.ts";

const { stdout, stderr, exitCode } = await runSupabase(["login", "--token", token]);
expect(exitCode).toBe(0);
expect(stdout).toContain("Logged in successfully");
```
