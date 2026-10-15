import { Effect, Exit, Schedule, Scope } from "effect";
import type { Duration } from "effect";
import { namespaceError, type NamespaceError } from "./Capabilities.ts";
import { acquireLock, isBusy, takeLock } from "./drivers/Sqlite.ts";

/**
 * Takes the exclusive lock at `file` for the enclosing scope, waiting up to `budget` for another
 * holder. Each attempt owns a child scope, so a failed open or lock never leaks the connection.
 */
export const holdLock = (
  file: string,
  budget: Duration.Input,
  subject: string,
): Effect.Effect<void, NamespaceError, Scope.Scope> =>
  Effect.gen(function* () {
    const held = yield* Effect.scope;
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const attempt = yield* Scope.fork(held, "sequential");
        yield* acquireLock(file, "create").pipe(
          Scope.provide(attempt),
          Effect.flatMap(takeLock),
          Effect.onExit((exit) =>
            Exit.isFailure(exit) ? Scope.close(attempt, exit) : Effect.void,
          ),
        );
      }),
    ).pipe(
      Effect.retry({
        schedule: Schedule.spaced("50 millis").pipe(Schedule.upTo({ duration: budget })),
        while: isBusy,
      }),
      Effect.catchIf(isBusy, () =>
        Effect.fail(
          namespaceError("lock", `${subject} is locked by another operation; retry shortly`),
        ),
      ),
    );
  });
