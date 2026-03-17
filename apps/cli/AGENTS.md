# Learning more about the "effect" library

This project uses **Effect V4**. The full source code for the `effect` library is in `.repos/effect/`.

Use this for learning more about the library, rather than browsing the code in
`node_modules/`. See `.repos/effect/MIGRATION.md` for V3 → V4 changes.

## Prefer `Effect.fnUntraced` over functions that return `Effect.gen` when tracing isn't needed

Instead of writing:

```ts
const fn = (param: string) =>
  Effect.gen(function* () {
    // ...
  });
```

Prefer:

```ts
const fn = Effect.fnUntraced(function* (param: string) {
  // ...
});
```

Do not use `as` casts to paper over Effect or CLI typing issues. Fix the type relationships directly, or restructure the code until the compiler is satisfied without assertions.

## Testing

Use `bun run test` (not `bun test`) to run tests. The package.json `test` script runs all Vitest projects with coverage enabled for the `core` project.

Use `bun run test:core` for the main in-process suite and `bun run test:e2e` for the sequential subprocess suite.

Always run the relevant unit and integration tests automatically for the command or workspace you changed.
Do not run the full e2e suite automatically. Only run e2e when the user asks, or when you need extra confidence for the command you touched.
When running e2e automatically, run only the targeted `*.e2e.test.ts` file(s) for the command you changed.

When running the CLI from source, always invoke it as `bun src/supabase.ts ...` directly. Do not use `bun run src/supabase.ts` because of Bun bug #11400.

Command handler integration tests must achieve **100% branch coverage**.

Read https://www.effect.solutions/testing for Effect testing patterns. Note that the guide targets Effect V3 — adapt to V4 APIs using the source code in `.repos/effect/packages/effect/` and `.repos/effect/packages/vitest/`.

### Test categories

- `*.test.ts` belongs to the `core` Vitest project and is the default for unit-style and other fast in-process tests.
- `*.integration.test.ts` also belongs to the `core` project and is for in-process integration tests that exercise real handler or service behavior with layered dependency replacement.
- `*.e2e.test.ts` belongs to the `e2e` Vitest project and is for black-box CLI subprocess tests.

### Testing policy

- Prefer integration tests over unit tests for command behavior.
- New command behavior should usually be covered in `*.integration.test.ts` first.
- Prefer the highest-level in-process test that exercises the real behavior with stable, local feedback.
- Use `*.test.ts` for pure logic, parsing, formatting, small state machines, and narrow edge cases that are awkward or noisy to cover through handlers.
- Unit-style tests should prefer real collaborators and avoid mocking by default.
- Small fakes are acceptable only at true boundaries such as filesystem, env, clock, TTY, process, browser, or network.
- If a test needs multiple service replacements or `Layer.mergeAll(...)`, it likely belongs in `*.integration.test.ts`.
- Prefer assertions on outputs and accumulated state over spy-heavy interaction tests.
- Keep `*.e2e.test.ts` focused on golden paths, CLI surface behavior, and subprocess correctness, not branch-by-branch coverage.

## Go CLI parity tracking

When you add or change CLI commands, subcommands, flags, or parameters, always update [`docs/go-cli-porting-status.md`](./docs/go-cli-porting-status.md).

- Update status when a Go leaf command moves between `missing`, `partial`, and `ported`.
- Update missing or extra flag/parameter notes when the command surface changes.
- Keep the tracker focused on final leaf commands, not command groups.
- If you add a TS-native command with no direct Go equivalent (for example `dev`), record it in the TS-only section instead of marking a Go command as ported.

## Code quality

After finishing any task or refactor, always run all quality checks before considering the work done:

```sh
bun run test
bun run --parallel "*:check"
```

## `.repos/lalph/`

[lalph](https://github.com/tim-smart/lalph) is a CLI written by Tim Smart, a core maintainer of Effect, using Effect V4. Study its source code to determine good practices and patterns when building CLI applications with Effect.

## `.repos/effect-patterns/`

[effect-patterns](https://github.com/effect-ts-community/effect-patterns) contains practical patterns for structuring Effect services, layers, and error handling. Note that the code targets **Effect V3** — adapt the idioms to V4 APIs using `.repos/effect/MIGRATION.md` and the V4 source code.

## `.repos/supabase-cli-go/`

The [old Supabase CLI](https://github.com/supabase/cli) written in Go. When the user mentions the "old CLI", look here for reference on how things were previously implemented (config format, command structure, feature set, etc.).
