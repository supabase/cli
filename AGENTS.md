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
- Standard scripts: `test`, `types:check`, `lint:check`, `lint:fix`, `fmt:check`, `fmt:fix`, `knip:check`, `knip:fix`
- Standard devDependencies: `@tsconfig/bun`, `@types/bun`, `@typescript/native-preview`, `knip`, `oxfmt`, `oxlint`, `oxlint-tsgolint`

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

## Code Quality

Run quality checks from the workspace directory you changed. Do not consider a task complete until all relevant scripts pass.
Do not waive or defer failing checks in a changed workspace as "pre-existing". If a required check fails, fix it before closing the task. Only treat a failure as an external blocker when it cannot be resolved within the workspace, and in that case call it out explicitly.
If you run a workspace check command such as `pnpm types:check && pnpm lint:check && pnpm fmt:check`, you own all failing checks in that workspace for the duration of the task, even if the failing files look unrelated. Do not leave the workspace with unresolved failing checks after running the command.
Do not use TypeScript `as` casts to silence type errors in production code. If a type does not line up, fix the typing or restructure the code until it type-checks cleanly.

For the standard Bun/TypeScript workspaces:

```sh
pnpm check:all
pnpm lint:fix && pnpm fmt:fix
pnpm test
```

If a workspace exposes a different script set, use that workspace's `package.json` as the source of truth.

## Nx

This repo uses Nx for task orchestration. Prefer Nx commands over running scripts directly when working across projects or when you need to understand project structure.

### Exploring the workspace

```sh
# List all projects
nx show projects

# Show targets and metadata for a specific project
nx show project <name> --json

# Visualize the project dependency graph
nx graph
```

### Running tasks

```sh
# Run a single target
nx run <project>:<target>

# Run a target across all projects
nx run-many -t <target>

# Run a target only on projects affected by current changes
nx affected -t <target>

# Run multiple targets (e.g. build + test)
nx run-many -t build test
```

Use `nx show project <name> --json` to discover available targets before running them — do not guess target names.

## Pull Requests

PR titles must follow conventional-commits format because the `Lint Pull Request` workflow runs `amannn/action-semantic-pull-request` against the title. Use `<type>(<scope>): <subject>` (e.g. `fix(cli): …`, `test(cli): …`, `feat(api): …`). A bare descriptive title like "Build TypeScript CLI as compiled Bun binaries" will fail the lint. When a PR is created (including by the Claude Code UI or someone else), check the title against this rule and update it if needed.
Do not include a validation, test plan, or list of checks in PR descriptions. CI enforces validation for PRs, so PR descriptions should focus on what changed, why it changed, and any reviewer-relevant context that CI cannot infer.

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
