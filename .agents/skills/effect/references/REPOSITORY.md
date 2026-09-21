# Repository guidance

These repository-specific conventions take precedence over the general skill defaults.

Effect V4 source is in `.repos/effect/`; use it instead of `node_modules`, with core APIs in
`.repos/effect/packages/effect/`, test helpers in `.repos/effect/packages/vitest/`, and migration
notes in `.repos/effect/MIGRATION.md`. These are read-only source checkouts that may be ahead of
installed dependencies; when APIs differ, use the matching release tag inside the reference
repository. Run `pnpm repos:install` if it is absent.

- Write all TypeScript runtime code in Effect. Internal helpers return Effects; Promise-returning
  APIs belong only at package exports for consumers that do not use Effect. Wrap a foreign Promise once at its leaf with `Effect.tryPromise`,
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
  [telemetry identity rule](../../../../apps/cli/AGENTS.md#telemetry).
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

Effect lint covers a growing allow list of areas, defined by the `!` entries in
`.oxlintrc.effect.json` (the source of truth) and enforced through the root scripts; it
currently spans `packages/stack`, the experimental and smaller `apps/cli/src/commands`
families and most of the shared compute runtime, and expands area by area.

## Testing

For CLI commands, integration-test handlers and feature matrices with realistic Effect layers.
Use `@effect/vitest`'s `it.live` with stateful mock factories returning `{ layer, state }`;
assert resulting state and user-visible behavior, not `vi.fn()` call details. See
[the login integration test](../../../../apps/cli/src/commands/login/login.integration.test.ts).
Use `TestClock` for Effect timing semantics.
