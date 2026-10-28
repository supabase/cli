import { Effect, Exit, Schedule, Schema, Scope } from "effect";
import type { Duration } from "effect";
import { namespaceError, type NamespaceError } from "./Capabilities.ts";
import type { DatabaseSync } from "node:sqlite";
import {
  acquireLock,
  isBusy,
  takeExclusiveLock,
  takeLock,
  takeSharedLock,
} from "./drivers/Sqlite.ts";

class LockBusy extends Schema.TaggedError<LockBusy>()("Namespace.LockBusy", {
  message: Schema.String,
}) {}

/** Whether `error` is a {@link holdLock} failure because another holder kept the lock for the whole budget. */
export const isLockBusy = (error: NamespaceError): boolean => Schema.is(LockBusy)(error.cause);

/**
 * Takes the exclusive lock at `file` for the enclosing scope, waiting up to `budget` for another
 * holder. Each attempt owns a child scope, so a failed open or lock never leaks the connection.
 */
export const holdLock = (
  file: string,
  budget: Duration.Input,
  subject: string,
): Effect.Effect<void, NamespaceError, Scope.Scope> => holdWith(takeLock, file, budget, subject);

/**
 * Takes a shared lock at `file` for the enclosing scope: shared holders coexist, and only a
 * {@link holdExclusiveLock} holder makes them wait, up to `budget`.
 */
export const holdSharedLock = (
  file: string,
  budget: Duration.Input,
  subject: string,
): Effect.Effect<void, NamespaceError, Scope.Scope> =>
  holdWith(takeSharedLock, file, budget, subject);

/**
 * Takes the lock at `file` exclusively of every {@link holdSharedLock} holder for the enclosing
 * scope, waiting up to `budget` for them to release.
 */
export const holdExclusiveLock = (
  file: string,
  budget: Duration.Input,
  subject: string,
): Effect.Effect<void, NamespaceError, Scope.Scope> =>
  holdWith(takeExclusiveLock, file, budget, subject);

const holdWith = (
  take: (connection: DatabaseSync) => Effect.Effect<void, NamespaceError>,
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
          Effect.flatMap(take),
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
          namespaceError(
            "lock",
            new LockBusy({ message: `${subject} is locked by another operation; retry shortly` }),
          ),
        ),
      ),
    );
  });
