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

## Testing

Use `bun run test` (not `bun test`) to run tests. The package.json `test` script runs `vitest run`, which is required for proper test execution with coverage.

When running the CLI from source, always invoke it as `bun src/supabase.ts ...` directly. Do not use `bun run src/supabase.ts` because of Bun bug #11400.

Command handler integration tests must achieve **100% branch coverage**.

Read https://www.effect.solutions/testing for Effect testing patterns. Note that the guide targets Effect V3 — adapt to V4 APIs using the source code in `.repos/effect/packages/effect/` and `.repos/effect/packages/vitest/`.

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
