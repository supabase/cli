// oxlint-disable-next-line effecttsgo/node-builtin-import -- FileSystem has no OS-owned cross-process lock primitive.
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { Effect, Predicate, Scope } from "effect";
import { namespaceError, type NamespaceError } from "../Capabilities.ts";
import { takeSharedLockSync } from "./sqlite-pin.ts";

const openConnection = (path: string, mode: "create" | "existing") =>
  Effect.try({
    try: () =>
      mode === "create"
        ? new DatabaseSync(path)
        : new DatabaseSync(new URL(`${pathToFileURL(path).href}?mode=rw`)),
    catch: (cause) => namespaceError("lock-open", cause),
  });
const closeConnection = (connection: DatabaseSync) =>
  Effect.try({
    // Rolls back first: closing a connection mid-transaction must release its lock immediately,
    // and must not depend on `close()` alone to do so. A connection with no open transaction (for
    // example `acquireLock("create")` with no lock ever taken) has nothing to roll back.
    try: () => {
      try {
        connection.exec("ROLLBACK");
      } catch {
        // No open transaction; nothing to roll back.
      }
      connection.close();
    },
    catch: (cause) => namespaceError("lock-close", cause),
  });

/**
 * Opens `path` for the enclosing scope and runs `init` once on the new connection; a failing
 * `init` closes the connection before the error propagates.
 */
export const openDatabase = (
  path: string,
  init: (connection: DatabaseSync) => void,
): Effect.Effect<DatabaseSync, NamespaceError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      try: () => {
        const connection = new DatabaseSync(path);
        try {
          init(connection);
        } catch (error) {
          connection.close();
          throw error;
        }
        return connection;
      },
      catch: (cause) => namespaceError("open", cause),
    }),
    (connection) =>
      closeConnection(connection).pipe(
        Effect.catch((error) => Effect.logWarning(`Unable to close ${path}`, error)),
      ),
  );

/** Matches a `NamespaceError`'s cause against one of `node:sqlite`'s numeric `errcode`s. */
export const errcode = (cause: unknown, code: number) =>
  Predicate.hasProperty(cause, "errcode") && cause.errcode === code;
/** SQLite reports lock contention under `busy_timeout = 0` with this errcode. */
export const isBusy = (error: NamespaceError) => errcode(error.cause, 5);
/** `acquireLock("existing")` reports this errcode when the database file does not exist. */
export const isMissing = (error: NamespaceError) => errcode(error.cause, 14);
/**
 * Opens `path`'s connection for the enclosing scope. Every connection this process opens on a
 * path shares one SQLite library instance, which tracks locks per inode across connections and
 * keeps them held until the last one closes, so a second in-process connection contends with the
 * first exactly as another process would.
 */
export const acquireLock = (
  path: string,
  mode: "create" | "existing",
): Effect.Effect<DatabaseSync, NamespaceError, Scope.Scope> =>
  Effect.acquireRelease(openConnection(path, mode), (connection) =>
    closeConnection(connection).pipe(
      Effect.catch((error) => Effect.logWarning(`Unable to close ${path}`, error)),
    ),
  );

/**
 * Takes the connection's RESERVED write lock once; fails busy under any contention instead of
 * waiting. `BEGIN IMMEDIATE` alone excludes other writers, but not an existing reader's SHARED
 * lock (it only escalates to EXCLUSIVE, conflicting with readers, when a write is attempted), so
 * this is enough for writer-versus-writer exclusion only, such as one staging slot's own lock.
 */
export const takeLock = (connection: DatabaseSync): Effect.Effect<void, NamespaceError> =>
  Effect.gen(function* () {
    yield* Effect.try({
      try: () => connection.exec("PRAGMA busy_timeout = 0"),
      catch: (cause) => namespaceError("lock", cause),
    });
    yield* Effect.try({
      try: () => connection.exec("BEGIN IMMEDIATE"),
      catch: (cause) => namespaceError("lock", cause),
    });
  });

/**
 * Takes the connection's EXCLUSIVE lock once, immediately, in rollback-journal mode: unlike
 * `BEGIN IMMEDIATE`, this conflicts with an existing reader's SHARED lock right away, which is
 * what retirement needs to safely exclude a live pin. Fails busy under any contention.
 */
export const takeExclusiveLock = (connection: DatabaseSync): Effect.Effect<void, NamespaceError> =>
  Effect.gen(function* () {
    yield* Effect.try({
      try: () => connection.exec("PRAGMA busy_timeout = 0"),
      catch: (cause) => namespaceError("lock", cause),
    });
    yield* Effect.try({
      try: () => connection.exec("BEGIN EXCLUSIVE"),
      catch: (cause) => namespaceError("lock", cause),
    });
  });

/**
 * Takes the connection's SHARED read lock once: a real `SELECT` against a lazily created one-row
 * table, held until the connection commits or closes. Busy under a concurrent EXCLUSIVE holder.
 */
export const takeSharedLock = (connection: DatabaseSync): Effect.Effect<void, NamespaceError> =>
  Effect.try({
    try: () => takeSharedLockSync(connection),
    catch: (cause) => namespaceError("lock", cause),
  });
