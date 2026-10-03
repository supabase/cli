// oxlint-disable-next-line effecttsgo/node-builtin-import -- FileSystem has no OS-owned cross-process lock primitive.
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { Effect, Predicate, Scope } from "effect";
import { namespaceError, type NamespaceError } from "../Capabilities.ts";

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
    try: () => connection.close(),
    catch: (cause) => namespaceError("lock-close", cause),
  });

/** Matches a `NamespaceError`'s cause against one of `node:sqlite`'s numeric `errcode`s. */
export const errcode = (cause: unknown, code: number) =>
  Predicate.hasProperty(cause, "errcode") && cause.errcode === code;
/** SQLite reports lock contention under `busy_timeout = 0` with this errcode. */
export const isBusy = (error: NamespaceError) => errcode(error.cause, 5);
const busy = (operation: string) =>
  namespaceError(operation, Object.assign(new Error("locked by this process"), { errcode: 5 }));

/**
 * Canonical paths this process currently has a connection open on. POSIX advisory locks (and the
 * SQLite locks built on them) belong to a process, not a descriptor: a second connection this
 * process opened on the same path would not see the first one's lock as contention, so it would
 * wrongly appear to succeed instead of reporting busy. Checking this set first, before opening a
 * second descriptor, rules that out: a path already open in this process is always busy.
 */
const openPaths = new Set<string>();

/**
 * Opens `path`'s connection for the enclosing scope; busy if this process already has it open.
 * Reserving the path and opening the connection happen as one `acquireRelease` acquisition, so an
 * interruption can never leave the path reserved without a connection whose release clears it.
 */
export const acquireLock = (
  path: string,
  mode: "create" | "existing",
): Effect.Effect<DatabaseSync, NamespaceError, Scope.Scope> =>
  Effect.gen(function* () {
    if (openPaths.has(path)) return yield* busy("lock");
    return yield* Effect.acquireRelease(
      Effect.sync(() => openPaths.add(path)).pipe(
        Effect.andThen(openConnection(path, mode)),
        Effect.tapError(() => Effect.sync(() => openPaths.delete(path))),
      ),
      (connection) =>
        closeConnection(connection).pipe(
          Effect.catch((error) => Effect.logWarning(`Unable to close ${path}`, error)),
          Effect.ensuring(Effect.sync(() => openPaths.delete(path))),
        ),
    );
  });

/** Takes the connection's write lock once; fails busy under any contention instead of waiting. */
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
