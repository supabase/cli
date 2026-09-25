import { Cause, Effect, Exit } from "effect";
import type { StackApi } from "../../src/command-internal/stack-api.ts";
import { destroyTestStack } from "../../../../packages/stack/tests/stack-cleanup.ts";

export const destroyTestStacks = (
  api: StackApi["Service"],
  stateRoot: string,
  cacheRoot: string,
): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const definitions = yield* api.discover({ stateRoot });
    const exits = yield* Effect.forEach(
      definitions,
      ({ definition }) =>
        api
          .open({ id: definition.id, stateRoot, cacheRoot })
          .pipe(Effect.flatMap(destroyTestStack), Effect.scoped, Effect.exit),
      { concurrency: "unbounded" },
    );
    const failures = exits.filter(Exit.isFailure);
    const first = failures[0];
    if (first !== undefined) {
      const combined = failures
        .slice(1)
        .reduce((cause, exit) => Cause.combine(cause, exit.cause), first.cause);
      yield* Effect.failCause(combined);
    }
  }).pipe(Effect.orDie);
