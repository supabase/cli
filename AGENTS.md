# Supa

Bun monorepo with workspaces under `packages/`.

## Package Structure

All packages should follow this standard structure (see `packages/process-compose` as reference):

**package.json:**

- `name`: `@supabase/<package-name>`
- `private`: true
- `type`: "module"
- Standard scripts: `test`, `types:check`, `lint:check`, `lint:fix`, `fmt:check`, `fmt:fix`, `knip:check`, `knip:fix`
- Standard devDependencies: `@tsconfig/bun`, `@types/bun`, `@typescript/native-preview`, `knip`, `oxfmt`, `oxlint`, `oxlint-tsgolint`

**tsconfig.json:**

```json
{
  "extends": "@tsconfig/bun/tsconfig.json"
}
```

## Effect

The complete source code for the `effect` library (V4) is in `.repos/effect/`. Study types, APIs, and patterns there instead of `node_modules/`.

Key packages:
- `.repos/effect/packages/effect/` — core `effect` library
- `.repos/effect/packages/vitest/` — `@effect/vitest` test helpers
- `.repos/effect/MIGRATION.md` — V3 → V4 migration guide

## Code Quality

Always run these scripts from the package directory after making any changes — do not consider a task complete until all pass:

```sh
bun run --parallel "*:check"   # Run all quality checks in parallel
bun run --parallel "*:fix"     # Auto-fix lint, format, and unused exports in parallel
bun run test                   # Run tests via the package's Vitest script
```

## Refactoring Policy

None of this code is published, so backward compatibility is not a constraint. Prefer the simplest correct design, including substantial refactors, API reshaping, and deleting obsolete code when it improves the codebase.

## Testing

See `packages/cli/src/commands/login/` as the canonical example.

### File naming

- `*.test.ts` — unit tests, colocated next to source
- `*.integration.test.ts` — integration tests, colocated next to source
- `*.e2e.test.ts` — end-to-end tests, colocated next to source
- `tests/` — shared test helpers (e.g. `tests/helpers/cli.ts`)

### Testing pyramid for CLI commands

1. **Unit tests** on `lib/` — pure functions, no Effect context needed
2. **Integration tests** on handlers — business logic with mocked Effect services via `Layer.succeed` (bulk of tests)
3. **E2e tests** — 2–4 per command covering the golden path and basic error output

### Integration test pattern

Uses `@effect/vitest` with `it.live` — stateful mock factories return `{ layer, state }`. No `vi.fn()` spies; assert on accumulated state after the effect runs:

```ts
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";

// Mock factories return layer + observable state
function mockCredentials(opts: { existingToken?: string } = {}) {
  let savedToken: string | undefined;
  return {
    layer: Layer.succeed(Credentials, {
      getAccessToken: Effect.sync(() => opts.existingToken ?? savedToken),
      saveAccessToken: (token: string) => Effect.sync(() => { savedToken = token; }),
    }),
    get savedToken() { return savedToken; },
  };
}

// Setup helpers compose layers and return all state
function setupTty(opts = {}) {
  const creds = mockCredentials(opts);
  const out = mockOutput(opts);
  const api = mockApi(opts);
  const layer = Layer.mergeAll(emptyEnv(), api.layer, creds.layer, mockCrypto(), ...);
  return { layer, creds, out, api };
}

// Success path — assert on state
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

// Error path
it.live("fails with SomeError", () => {
  const { layer } = setupTty();
  return Effect.gen(function* () {
    const exit = yield* myEffect(args).pipe(Effect.exit);
    expect(Exit.isFailure(exit)).toBe(true);
  }).pipe(Effect.provide(layer));
});
```

### E2e test pattern

Use the `runSupabase()` helper from `tests/helpers/cli.ts` which spawns a real CLI subprocess with an isolated temp HOME:

```ts
import { describe, expect, test } from "vitest";
import { runSupabase } from "../../tests/helpers/cli.ts";

const { stdout, stderr, exitCode } = await runSupabase(["login", "--token", token]);
expect(exitCode).toBe(0);
expect(stdout).toContain("Logged in successfully");
```
