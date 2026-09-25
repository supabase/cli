import { Config, Effect, FileSystem, Option, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { ServiceError } from "../Service.ts";

/** Names the non-root system user that runs native PostgreSQL when the stack itself runs as root. */
export const NATIVE_POSTGRES_USER_ENV = "SUPABASE_NATIVE_POSTGRES_USER";

export interface PasswdEntry {
  readonly name: string;
  readonly uid: number;
  readonly gid: number;
  readonly home: string;
}

type Environment = Readonly<Record<string, string | undefined>>;

/** Agent sandboxes that run as root by default, and the accounts they provide for unprivileged work. */
const sandboxes = [
  {
    name: "Claude Code sandbox",
    detect: (env: Environment) => (env["CLAUDECODE"] ?? "") !== "" && env["IS_SANDBOX"] === "yes",
    preferredUsers: ["ubuntu"],
  },
];
const environmentNames = [NATIVE_POSTGRES_USER_ENV, "CLAUDECODE", "IS_SANDBOX"];

export type NativePostgresUser =
  | { readonly _tag: "NotNeeded" }
  | { readonly _tag: "StepDown"; readonly user: PasswdEntry; readonly message: string }
  | { readonly _tag: "Unavailable"; readonly message: string; readonly suggestion: string };

const suggestion = `Set ${NATIVE_POSTGRES_USER_ENV}=<user> to run PostgreSQL as a non-root user.`;
const unavailable = (message: string): NativePostgresUser => ({
  _tag: "Unavailable",
  message,
  suggestion,
});

export const parsePasswd = (content: string): ReadonlyArray<PasswdEntry> =>
  content.split("\n").flatMap((line) => {
    const [name = "", , uid = "", gid = "", , home = ""] = line.split(":");
    return /^\d+$/u.test(uid) && /^\d+$/u.test(gid)
      ? [{ name, uid: Number(uid), gid: Number(gid), home }]
      : [];
  });

const isUsable = ({ name, uid, gid }: PasswdEntry): boolean =>
  uid !== 0 && gid !== 0 && uid !== 65_534 && name !== "nobody";

/** initdb and the server both refuse uid 0, so a root stack must hand PostgreSQL to another user or fail before spawning. */
export const resolvePostgresUser = (input: {
  readonly runtime: string;
  readonly uid: number | undefined;
  readonly env: Environment;
  readonly passwd: ReadonlyArray<PasswdEntry>;
}): NativePostgresUser => {
  if (input.runtime !== "native" || input.uid !== 0) return { _tag: "NotNeeded" };
  const sandbox = sandboxes.find(({ detect }) => detect(input.env));
  const where = sandbox === undefined ? "Running as root" : `Running as root in ${sandbox.name}`;
  const stepDown = (user: PasswdEntry, how: string): NativePostgresUser => ({
    _tag: "StepDown",
    user,
    message: `${where}; PostgreSQL will run as ${how} '${user.name}' (uid ${user.uid})`,
  });
  const override = input.env[NATIVE_POSTGRES_USER_ENV] ?? "";
  if (override !== "") {
    const user = input.passwd.find(({ name }) => name === override);
    if (user === undefined)
      return unavailable(`${NATIVE_POSTGRES_USER_ENV}=${override} does not name a known user`);
    return isUsable(user)
      ? stepDown(user, `${NATIVE_POSTGRES_USER_ENV} user`)
      : unavailable(
          `${NATIVE_POSTGRES_USER_ENV}=${override} resolves to uid ${user.uid} and gid ${user.gid}, which cannot run PostgreSQL`,
        );
  }
  if (sandbox === undefined) return unavailable("PostgreSQL cannot be run as root");
  const usable = input.passwd.filter(isUsable);
  const preferred = sandbox.preferredUsers
    .map((name) => usable.find((user) => user.name === name))
    .find((user) => user !== undefined);
  if (preferred !== undefined) return stepDown(preferred, "preferred user");
  const scanned =
    usable.find(({ name }) => name === "postgres") ??
    usable.filter(({ uid }) => uid >= 1000).sort((left, right) => left.uid - right.uid)[0];
  return scanned === undefined
    ? unavailable(`PostgreSQL cannot be run as root and ${sandbox.name} has no non-root user`)
    : stepDown(scanned, "detected user");
};

/** Resolves the PostgreSQL process user for the current process from its environment and `/etc/passwd`. */
export const resolveNativePostgresUser = Effect.fn("NativePostgresUser.resolve")(function* (
  runtime: string,
) {
  const uid = process.getuid?.();
  if (runtime !== "native" || uid !== 0)
    return resolvePostgresUser({ runtime, uid, env: {}, passwd: [] });
  const fs = yield* FileSystem.FileSystem;
  const env: Record<string, string> = {};
  for (const name of environmentNames) {
    const value = yield* Config.option(Config.string(name)).pipe(
      Effect.orElseSucceed(() => Option.none()),
    );
    if (Option.isSome(value)) env[name] = value.value;
  }
  const passwd = yield* fs.readFileString("/etc/passwd").pipe(
    Effect.map(parsePasswd),
    Effect.orElseSucceed(() => []),
  );
  return resolvePostgresUser({ runtime, uid, env, passwd });
});

const ancestorsOf = (path: Path.Path, start: string): ReadonlyArray<string> => {
  const parent = path.dirname(start);
  return parent === start ? [start] : [start, ...ancestorsOf(path, parent)];
};

/**
 * Restricts a directory to its owner but keeps an existing traverse-only grant, because a
 * stepped-down PostgreSQL resolves bundle and data paths through the cache and state roots while it runs.
 */
export const restrictDirectoryToOwner = (fs: FileSystem.FileSystem, directory: string) =>
  fs
    .stat(directory)
    .pipe(Effect.flatMap(({ mode }) => fs.chmod(directory, 0o700 | (mode & 0o001))));

const allowTraverse = Effect.fn("NativePostgresUser.allowTraverse")(function* (
  user: PasswdEntry,
  directories: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  for (const directory of directories) {
    const { mode } = yield* fs.stat(directory);
    if ((mode & 0o001) !== 0) continue;
    yield* fs.chmod(directory, (mode & 0o7777) | 0o001);
    yield* Effect.logInfo(`Added traverse permission (o+x) on ${directory} for '${user.name}'`);
  }
});

const requireOwnedByRootOr = Effect.fn("NativePostgresUser.requireOwnedByRootOr")(function* (
  user: PasswdEntry,
  target: string,
) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(target))) return;
  const owner = Option.getOrUndefined((yield* fs.stat(target)).uid);
  // Files another account already owns may carry that account's edits or links.
  if (owner !== 0 && owner !== user.uid)
    return yield* new ServiceError({
      operation: "launch",
      message: `${target} belongs to uid ${String(owner)}, not '${user.name}'; reset the database or re-prepare the PostgreSQL artifact`,
    });
});

/**
 * Root writes the key inside the instance directory on every launch, so every directory on its real
 * path must be owned by root and writable only by root (or a sticky ancestor), and nothing root is
 * about to write may belong to another account. Returns the real path root should use.
 */
export const openNativePostgresInstance = Effect.fn("NativePostgresUser.openInstance")(function* (
  user: PasswdEntry,
  instanceRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const realRoot = yield* fs.realPath(instanceRoot);
  const directories = ancestorsOf(path, realRoot);
  for (const directory of directories) {
    const info = yield* fs.stat(directory);
    const sticky = directory !== realRoot && (info.mode & 0o1000) !== 0;
    const writableByOthers = (info.mode & 0o022) !== 0 && !sticky;
    if (Option.getOrUndefined(info.uid) !== 0 || writableByOthers)
      return yield* new ServiceError({
        operation: "launch",
        message: `${directory} must be owned and writable only by root to run PostgreSQL as '${user.name}'`,
      });
  }
  yield* requireOwnedByRootOr(user, path.join(realRoot, "data"));
  yield* requireOwnedByRootOr(user, path.join(realRoot, "pgsodium_root.key"));
  yield* allowTraverse(user, directories);
  return realRoot;
});

/** The bundle's first-boot init runs `chmod +x` on this script, which only its owner may do. */
const GETKEY_SCRIPT = "share/supabase-cli/config/pgsodium_getkey.sh";

/** Hands the instance data, key, socket, HBA file, and the bundle's getkey script to the PostgreSQL user. */
export const handOverNativePostgresFiles = Effect.fn("NativePostgresUser.handOverFiles")(function* (
  user: PasswdEntry,
  paths: {
    readonly dataPath: string;
    readonly rootKeyPath: string;
    readonly socketPath: string;
    readonly hbaPath: string;
    readonly bundleRoot: string;
    readonly executable: string;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const getkey = path.join(paths.bundleRoot, GETKEY_SCRIPT);
  const hasGetkey = yield* fs.exists(getkey);
  const targets = [paths.dataPath, paths.rootKeyPath, paths.socketPath, paths.hbaPath];
  if (hasGetkey) {
    yield* requireOwnedByRootOr(user, getkey);
    targets.push(getkey);
  }
  // -P never follows symlinks inside the tree, and directories change owner after their contents.
  const status = yield* spawner.exitCode(
    ChildProcess.make("chown", ["-R", "-P", `${user.uid}:${user.gid}`, ...targets], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    }),
  );
  if (Number(status) !== 0)
    return yield* new ServiceError({
      operation: "launch",
      message: `chown exited with ${String(status)} while handing files to '${user.name}'`,
    });
  yield* allowTraverse(user, [
    ...ancestorsOf(path, path.dirname(paths.executable)),
    ...(hasGetkey ? ancestorsOf(path, path.dirname(getkey)) : []),
  ]);
});
