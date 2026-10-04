import { userInfo } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { NodeServices } from "@effect/platform-node";
import { Context, Effect, FileSystem, Layer, Path, Predicate, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";
import { namespaceError, type NamespaceError } from "./Capabilities.ts";
import { errcode, openSharedConnection } from "./drivers/Sqlite.ts";
import { lstatPath } from "./drivers/FileSystem.ts";

/** Identifies the stack that owns a port reservation. */
export interface Holder {
  readonly stackId: string;
  readonly stateRoot: string;
}

const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;

export interface Interface {
  /** The port this stack already reserves for `endpoint`, if it holds one. */
  readonly find: (
    stateRoot: string,
    stackId: string,
    endpoint: string,
  ) => Effect.Effect<number | undefined, NamespaceError>;
  /**
   * Reserves `port` for `(stateRoot, stackId, endpoint)`. Resolves to `undefined` once the row is
   * committed, or the live {@link Holder} already occupying `port` when it is taken.
   */
  readonly reserve: (
    stateRoot: string,
    stackId: string,
    endpoint: string,
    port: number,
  ) => Effect.Effect<Holder | undefined, NamespaceError>;
  /**
   * Atomically replaces `port`'s row with `(stateRoot, stackId, endpoint)`, but only while it still
   * belongs to `expected`. Resolves to `false` without changing anything once another reservation
   * has already claimed, reclaimed, or released it.
   */
  readonly reclaim: (
    port: number,
    expected: Holder,
    reservation: {
      readonly stateRoot: string;
      readonly stackId: string;
      readonly endpoint: string;
    },
  ) => Effect.Effect<boolean, NamespaceError>;
  /** Releases one endpoint's reservation; a no-op when it holds none. */
  readonly release: (
    stateRoot: string,
    stackId: string,
    endpoint: string,
  ) => Effect.Effect<void, NamespaceError>;
  /** Releases every reservation a stack holds, at its state root. */
  readonly releaseStack: (
    stateRoot: string,
    stackId: string,
  ) => Effect.Effect<void, NamespaceError>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@supabase/stack/PortReservations",
) {}

const schema = `
CREATE TABLE IF NOT EXISTS reservation (
  port INTEGER PRIMARY KEY,
  state_root TEXT NOT NULL,
  stack_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  UNIQUE (state_root, stack_id, endpoint)
)`;

interface HolderRow {
  readonly state_root: string;
  readonly stack_id: string;
}

const isPortRow = (value: unknown): value is { readonly port: number } =>
  Predicate.hasProperty(value, "port") && typeof value.port === "number";

const isHolderRow = (value: unknown): value is HolderRow =>
  Predicate.hasProperty(value, "state_root") &&
  typeof value.state_root === "string" &&
  Predicate.hasProperty(value, "stack_id") &&
  typeof value.stack_id === "string";

const connectionFor = (file: string): Effect.Effect<DatabaseSync, NamespaceError> =>
  openSharedConnection(file, (connection) => {
    // Short and bounded: real contention between two of this user's processes is brief, and
    // a blocking wait here is simpler than an async retry loop for a database this small. Set
    // before the schema statement, so even first-time table creation waits out a racing peer
    // instead of surfacing a spurious busy error.
    connection.exec("PRAGMA busy_timeout = 2000");
    connection.exec(schema);
  });

/**
 * Confirms `directory` (created 0700 if missing) is a real directory this uid owns, with the
 * no-follow {@link lstatPath} so a symlink planted ahead of us is refused rather than traversed.
 * Validates before changing any mode, so a symlink is never followed by `chmod` either.
 */
const securePrivateDirectory = Effect.fn("PortReservations.securePrivateDirectory")(function* (
  fs: FileSystem.FileSystem,
  directory: string,
) {
  yield* fs
    .makeDirectory(directory, { recursive: true, mode: 0o700 })
    .pipe(Effect.mapError((cause) => namespaceError("root", cause)));
  const info = yield* lstatPath(directory).pipe(
    Effect.mapError((cause) => namespaceError("root", cause)),
  );
  if (info === undefined || info.type !== "Directory")
    return yield* namespaceError("root", `${directory} is not a directory`);
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid)
    return yield* namespaceError(
      "root",
      `${directory} belongs to uid ${String(info.uid)}, not the current user`,
    );
  yield* fs.chmod(directory, 0o700).pipe(Effect.mapError((cause) => namespaceError("root", cause)));
});

/** `getent passwd <uid>` prints one `name:passwd:uid:gid:gecos:dir:shell` line; field 6 is home. */
const parseGetent = (output: string): string | undefined => output.trim().split(":")[5];

/** `dscacheutil -q user -a uid <uid>` prints `key: value` lines; `dir:` is home. */
const parseDscacheutil = (output: string): string | undefined => {
  for (const line of output.split("\n")) {
    const match = /^dir:\s*(.+)$/u.exec(line);
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
};

/**
 * Resolves the current user's home directly from the OS, never `$HOME`: on POSIX, `os.userInfo()`
 * itself prefers `$HOME` once a process starts with it set, which would let a sandboxed or
 * overridden environment move the registry. `getent`/`dscacheutil` read the system database
 * instead, so a caller's environment cannot steer this. Windows has neither a POSIX uid nor those
 * tools, so there `os.userInfo().homedir` reads the user profile directly instead.
 */
const resolvePasswdHome = Effect.fn("PortReservations.resolvePasswdHome")(function* () {
  if (process.platform === "win32") {
    const home = userInfo().homedir;
    if (home.length === 0)
      return yield* namespaceError("home", "Unable to resolve the Windows user profile home");
    return home;
  }
  const uid = process.getuid?.();
  if (uid === undefined)
    return yield* namespaceError(
      "home",
      "No uid to resolve a passwd home for (not a POSIX process)",
    );
  const [executable, args, parse] =
    process.platform === "darwin"
      ? (["dscacheutil", ["-q", "user", "-a", "uid", String(uid)], parseDscacheutil] as const)
      : (["getent", ["passwd", String(uid)], parseGetent] as const);
  yield* Effect.annotateCurrentSpan({
    "process.executable.name": executable,
    "process.arg_count": args.length,
  });
  const output = yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* ChildProcess.make(executable, args, {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
      const [text, exitCode] = yield* Effect.all(
        [child.stdout.pipe(Stream.decodeText, Stream.mkString), child.exitCode],
        { concurrency: 2 },
      );
      yield* Effect.annotateCurrentSpan("process.exit_code", Number(exitCode));
      return Number(exitCode) === 0 ? text : "";
    }),
  ).pipe(
    Effect.timeout("5 seconds"),
    Effect.mapError((cause) => namespaceError("home", cause)),
  );
  const home = parse(output);
  if (home === undefined || home.length === 0)
    return yield* namespaceError("home", `Unable to resolve the passwd home for uid ${uid}`);
  return home;
});

/**
 * Computed once per process, replayed for every later caller: the OS passwd home for this uid,
 * always through the real Node spawner. Tests regularly swap `ChildProcessSpawner` to sandbox
 * container orchestration; this low-level OS fact is not part of that contract, and must resolve
 * the same way regardless of what the ambient context provides.
 */
const resolvedHome: Effect.Effect<string, NamespaceError> = Effect.runSync(
  Effect.cached(resolvePasswdHome().pipe(Effect.provide(NodeServices.layer))),
);

/**
 * One SQLite database per OS user at `<passwd home>/.supabase/ports.sqlite`, the only authority on
 * which stack owns a public port across every state root on this machine.
 */
const make = Effect.fn("PortReservations.make")(function* (): Effect.fn.Return<
  Interface,
  NamespaceError,
  FileSystem.FileSystem | Path.Path
> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(yield* resolvedHome, ".supabase");
  yield* securePrivateDirectory(fs, directory);
  const connection = yield* connectionFor(path.join(directory, "ports.sqlite"));

  const toHolder = (row: HolderRow): Holder => ({
    stackId: row.stack_id,
    stateRoot: row.state_root,
  });

  const find = Effect.fn("PortReservations.find")(function* (
    stateRoot: string,
    stackId: string,
    endpoint: string,
  ) {
    const row = yield* Effect.try({
      try: () =>
        connection
          .prepare(
            "SELECT port FROM reservation WHERE state_root = ? AND stack_id = ? AND endpoint = ?",
          )
          .get(stateRoot, stackId, endpoint),
      catch: (cause) => namespaceError("find", cause),
    });
    return isPortRow(row) ? row.port : undefined;
  });

  const holderOf = (port: number): HolderRow | undefined => {
    const row = connection
      .prepare("SELECT state_root, stack_id FROM reservation WHERE port = ?")
      .get(port);
    return isHolderRow(row) ? row : undefined;
  };

  // Untraced: `Ports.ts`'s auto scan calls `reserve` and `reclaim` once per candidate port, and its
  // own span already records the attempt and failure counts for the whole scan.
  const reserve = Effect.fnUntraced(function* (
    stateRoot: string,
    stackId: string,
    endpoint: string,
    port: number,
  ) {
    return yield* Effect.try({
      try: () => {
        const insertRow = () =>
          connection
            .prepare(
              "INSERT INTO reservation (port, state_root, stack_id, endpoint) VALUES (?, ?, ?, ?)",
            )
            .run(port, stateRoot, stackId, endpoint);
        connection.exec("BEGIN IMMEDIATE");
        try {
          try {
            insertRow();
          } catch (error) {
            if (!errcode(error, SQLITE_CONSTRAINT_PRIMARYKEY)) throw error;
            // Still holding the write lock taken above: the conflicting row cannot change until we
            // commit or roll back, so this read is a consistent view of who really holds `port`.
            const row = holderOf(port);
            if (row !== undefined) {
              connection.exec("ROLLBACK");
              return toHolder(row);
            }
            // The row that caused the conflict is already gone within this same transaction's own
            // view (for example a concurrent release just ahead of us); nothing else can touch it
            // while we hold the lock, so retrying the insert now must succeed.
            insertRow();
          }
          connection.exec("COMMIT");
          return undefined;
        } catch (error) {
          connection.exec("ROLLBACK");
          throw error;
        }
      },
      catch: (cause) => namespaceError("reserve", cause),
    });
  });

  const reclaim = Effect.fnUntraced(function* (
    port: number,
    expected: Holder,
    reservation: {
      readonly stateRoot: string;
      readonly stackId: string;
      readonly endpoint: string;
    },
  ) {
    return yield* Effect.try({
      try: () => {
        connection.exec("BEGIN IMMEDIATE");
        try {
          const current = holderOf(port);
          if (
            current === undefined ||
            current.state_root !== expected.stateRoot ||
            current.stack_id !== expected.stackId
          ) {
            connection.exec("ROLLBACK");
            return false;
          }
          connection.prepare("DELETE FROM reservation WHERE port = ?").run(port);
          connection
            .prepare(
              "INSERT INTO reservation (port, state_root, stack_id, endpoint) VALUES (?, ?, ?, ?)",
            )
            .run(port, reservation.stateRoot, reservation.stackId, reservation.endpoint);
          connection.exec("COMMIT");
          return true;
        } catch (error) {
          connection.exec("ROLLBACK");
          throw error;
        }
      },
      catch: (cause) => namespaceError("reclaim", cause),
    });
  });

  const release = Effect.fn("PortReservations.release")(function* (
    stateRoot: string,
    stackId: string,
    endpoint: string,
  ) {
    yield* Effect.try({
      try: () =>
        connection
          .prepare("DELETE FROM reservation WHERE state_root = ? AND stack_id = ? AND endpoint = ?")
          .run(stateRoot, stackId, endpoint),
      catch: (cause) => namespaceError("release", cause),
    });
  });

  const releaseStack = Effect.fn("PortReservations.releaseStack")(function* (
    stateRoot: string,
    stackId: string,
  ) {
    yield* Effect.try({
      try: () =>
        connection
          .prepare("DELETE FROM reservation WHERE state_root = ? AND stack_id = ?")
          .run(stateRoot, stackId),
      catch: (cause) => namespaceError("release", cause),
    });
  });

  return { find, reserve, reclaim, release, releaseStack };
});

export const layer = Layer.effect(Service, make().pipe(Effect.map(Service.of)));
