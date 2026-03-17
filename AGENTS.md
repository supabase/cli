# Supabase

Bun monorepo with workspaces under `apps/` and `packages/`.

## Workspace Layout

- `apps/cli` — main `@supabase/cli` package
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
bun run repos:install
```

Key references:

- `.repos/effect/packages/effect/` — core `effect` library
- `.repos/effect/packages/vitest/` — `@effect/vitest` test helpers
- `.repos/effect/MIGRATION.md` — V3 to V4 migration guide

## Code Quality

Run quality checks from the workspace directory you changed. Do not consider a task complete until all relevant scripts pass.
Do not waive or defer failing checks in a changed workspace as "pre-existing". If a required check fails, fix it before closing the task. Only treat a failure as an external blocker when it cannot be resolved within the workspace, and in that case call it out explicitly.
If you run a workspace check command such as `bun run --parallel "*:check"`, you own all failing checks in that workspace for the duration of the task, even if the failing files look unrelated. Do not leave the workspace with unresolved failing checks after running the command.
Do not use TypeScript `as` casts to silence type errors in production code. If a type does not line up, fix the typing or restructure the code until it type-checks cleanly.

For the standard Bun/TypeScript workspaces:

```sh
bun run --parallel "*:check"
bun run --parallel "*:fix"
bun run test
```

If a workspace exposes a different script set, use that workspace's `package.json` as the source of truth.

## Refactoring Policy

None of this code is published as a stable internal platform API, so backward compatibility is not a constraint. Prefer the simplest correct design, including substantial refactors, API reshaping, and deleting obsolete code when it improves the codebase.

## Testing

See `apps/cli/src/commands/login/` as the canonical example.

### File naming

- `*.test.ts` — unit tests, colocated next to source
- `*.integration.test.ts` — integration tests, colocated next to source
- `*.e2e.test.ts` — end-to-end tests, colocated next to source
- `tests/` — shared test helpers (for example `tests/helpers/cli.ts`)

### Testing pyramid for CLI commands

1. **Unit tests** on `lib/` — pure functions, no Effect context needed
2. **Integration tests** on handlers — business logic with mocked Effect services via `Layer.succeed`
3. **E2e tests** — 2 to 4 tests per command covering the golden path and basic error output

### Test execution policy

- Always run unit and integration tests for the workspace you changed before considering the task done.
- Do not automatically run the full e2e suite as part of the normal feedback loop.
- Run e2e tests only when the user asks for them, or when you specifically need them for the command you touched.
- When you do run e2e tests automatically, run only the targeted e2e file(s) for the command you changed, not unrelated e2e tests.

### Integration test pattern

Uses `@effect/vitest` with `it.live` — stateful mock factories return `{ layer, state }`. Avoid `vi.fn()` spies; assert on accumulated state after the effect runs:

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
