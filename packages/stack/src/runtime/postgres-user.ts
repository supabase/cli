import { Config, Context, Crypto, Effect, FileSystem, Option, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { PlatformError } from "effect/PlatformError";
import { contentDigestHex } from "../internal/content-digest.ts";
import { lstatPath } from "../namespace/drivers/FileSystem.ts";
import { ServiceError } from "../Service.ts";

/** Names the non-root system user that runs native PostgreSQL when the stack itself runs as root. */
export const NATIVE_POSTGRES_USER_ENV = "SUPABASE_NATIVE_POSTGRES_USER";

/**
 * Base directory of the per-uid native runtime root. Always the system `/tmp` outside tests: its
 * protection is the administrator's, so no user-chosen base widens what recovery may delete.
 */
export const NativeRuntimeRootBase = Context.Reference<string>(
  "@supabase/stack/NativeRuntimeRootBase",
  { defaultValue: () => "/tmp" },
);

/** The per-uid private root every native socket directory nests under. */
export const nativeRuntimeRootPath = (path: Path.Path, base: string, uid: number): string =>
  path.join(base, `supabase-${uid}`);

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
  {
    // Set only in Modal Sandboxes, not Functions; images have no fixed account, so rely on the scan.
    name: "Modal Sandbox",
    detect: (env: Environment) => (env["MODAL_SANDBOX_ID"] ?? "") !== "",
    preferredUsers: [],
  },
];
const environmentNames = [NATIVE_POSTGRES_USER_ENV, "CLAUDECODE", "IS_SANDBOX", "MODAL_SANDBOX_ID"];

export type NativePostgresUser =
  | { readonly _tag: "NotNeeded" }
  | { readonly _tag: "StepDown"; readonly user: PasswdEntry; readonly message: string }
  | { readonly _tag: "Unavailable"; readonly message: string; readonly suggestion: string };

const suggestion =
  `Set ${NATIVE_POSTGRES_USER_ENV}=<user> to run PostgreSQL as a non-root user, creating one if ` +
  "needed (on Linux, for example `useradd --system --user-group supabase-postgres`).";
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

const isAlreadyExists = (error: PlatformError): boolean => error.reason._tag === "AlreadyExists";

/**
 * Confirms `target`'s unresolved state (one `lstat`, so a symlink is never followed) is a
 * directory worth trusting: owned by `uid`, or by root when `allowRootOwner`, and never writable by
 * group or others unless `allowStickyWritable` and the sticky bit guard it, as `/tmp` itself is.
 */
const confirmPrivateDirectory = Effect.fn("NativePostgresUser.confirmPrivateDirectory")(function* (
  target: string,
  uid: number,
  policy: { readonly allowRootOwner: boolean; readonly allowStickyWritable: boolean },
) {
  const info = yield* lstatPath(target).pipe(
    Effect.mapError(
      (cause) =>
        new ServiceError({ operation: "launch", message: `Unable to inspect ${target}`, cause }),
    ),
  );
  if (info?.type === "SymbolicLink")
    return yield* new ServiceError({
      operation: "launch",
      message: `${target} is a symlink; refusing to use it for the native runtime root`,
    });
  if (info === undefined || info.type !== "Directory")
    return yield* new ServiceError({
      operation: "launch",
      message: `${target} is not a directory; refusing to use it for the native runtime root`,
    });
  if (info.uid !== uid && !(policy.allowRootOwner && info.uid === 0))
    return yield* new ServiceError({
      operation: "launch",
      message: `${target} belongs to uid ${String(info.uid)}, not the current user; refusing to use it for the native runtime root`,
    });
  const writable = (info.mode & 0o022) !== 0;
  const sticky = (info.mode & 0o1000) !== 0;
  if (writable && !(policy.allowStickyWritable && sticky))
    return yield* new ServiceError({
      operation: "launch",
      message: `${target} is writable by group or others${policy.allowStickyWritable ? " without the sticky bit" : ""}; refusing to use it for the native runtime root`,
    });
  return info;
});

/**
 * Resolves and confirms the per-uid root native socket directories nest under: the configured base,
 * canonicalized with `realPath` so a symlink or replacement planted after this check can't retarget
 * it, then its `supabase-<uid>` leaf, confirmed owned by this uid alone with no write bit at all.
 * `create` additionally makes the leaf (mode 0700) first, tolerating a race with another of our own
 * processes.
 */
const resolveNativeRuntimeRoot = (create: boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = yield* NativeRuntimeRootBase;
    const uid = process.getuid?.() ?? 0;
    const canonicalBase = yield* fs
      .realPath(base)
      .pipe(
        Effect.mapError(
          (cause) =>
            new ServiceError({ operation: "launch", message: `Unable to resolve ${base}`, cause }),
        ),
      );
    // Every ancestor is checked too: a writable non-sticky one would let another uid rename the tree.
    for (const directory of ancestorsOf(path, canonicalBase))
      yield* confirmPrivateDirectory(directory, uid, {
        allowRootOwner: true,
        allowStickyWritable: true,
      });
    const root = nativeRuntimeRootPath(path, canonicalBase, uid);
    if (create)
      yield* fs.makeDirectory(root, { mode: 0o700 }).pipe(
        Effect.catchIf(isAlreadyExists, () => Effect.void),
        Effect.mapError(
          (cause) =>
            new ServiceError({ operation: "launch", message: `Unable to create ${root}`, cause }),
        ),
      );
    yield* confirmPrivateDirectory(root, uid, {
      allowRootOwner: false,
      allowStickyWritable: false,
    });
    return root;
  });

/** Acquires this process's native runtime root for a launch, creating the leaf if missing. */
export const acquireNativeRuntimeRoot = Effect.fn("NativePostgresUser.acquireRuntimeRoot")(() =>
  resolveNativeRuntimeRoot(true),
);

/** Resolves the native runtime root for recovery's containment check, without creating it. */
const resolveNativeRuntimeRootForRecovery = Effect.fn(
  "NativePostgresUser.resolveRuntimeRootForRecovery",
)(() => resolveNativeRuntimeRoot(false));

/**
 * The socket directory of one native database instance: a function of its data root and id alone,
 * so launch and recovery agree on it with nothing persisted. PostgreSQL limits a Unix socket path
 * (this directory plus `/.s.PGSQL.5432`) to 103 bytes, which bounds the runtime root base.
 */
export const nativeSocketDirectoryPath = (
  crypto: Crypto.Crypto,
  path: Path.Path,
  runtimeRoot: string,
  dataRoot: string,
  instanceId: string,
) =>
  contentDigestHex(crypto, `${dataRoot}\0${instanceId}`).pipe(
    Effect.map((digest) => path.join(runtimeRoot, `pg-${digest}`)),
  );

/**
 * Removes the socket directories of a stack's native database instances. A runtime root that is
 * missing is nothing to remove; one that is not safe to trust (a symlink, foreign owner or
 * writable by others) is warned about and left untouched.
 */
export const removeNativeSocketDirectories = Effect.fn(
  "NativePostgresUser.removeSocketDirectories",
)(function* (dataRoot: string, instanceIds: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const runtimeRoot = yield* resolveNativeRuntimeRootForRecovery().pipe(Effect.option);
  if (Option.isNone(runtimeRoot)) {
    const base = yield* NativeRuntimeRootBase;
    const leaf = nativeRuntimeRootPath(path, base, process.getuid?.() ?? 0);
    if ((yield* lstatPath(leaf)) !== undefined)
      yield* Effect.logWarning(
        `${leaf} is not a trusted native runtime root; leaving its socket directories`,
      );
    return;
  }
  yield* Effect.annotateCurrentSpan({ "instance.count": instanceIds.length });
  for (const instanceId of instanceIds)
    yield* fs.remove(
      yield* nativeSocketDirectoryPath(crypto, path, runtimeRoot.value, dataRoot, instanceId),
      { recursive: true, force: true },
    );
});

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

/**
 * A directory inside a published artifact generation keeps the archive's own mode for life, so
 * the step-down handover checks for the traverse bit (o+x) there instead of granting it: granting
 * it would mutate an already-published, content-addressed generation.
 */
const requireTraverse = Effect.fn("NativePostgresUser.requireTraverse")(function* (
  directories: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  for (const directory of directories) {
    const { mode } = yield* fs.stat(directory);
    if ((mode & 0o001) === 0)
      return yield* new ServiceError({
        operation: "launch",
        message: `${directory} is missing its traverse bit (o+x); re-prepare the artifact`,
      });
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

/** `chown -R -P uid:gid target`, failing with a message naming `target` and the recipient user. */
const chownRecursive = Effect.fn("NativePostgresUser.chownRecursive")(function* (
  user: PasswdEntry,
  target: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // -P never follows symlinks inside the tree, and directories change owner after their contents.
  const chownArgs = ["-R", "-P", `${user.uid}:${user.gid}`, target];
  yield* Effect.annotateCurrentSpan({
    "process.executable.name": "chown",
    "process.arg_count": chownArgs.length,
  });
  const status = yield* spawner.exitCode(
    ChildProcess.make("chown", chownArgs, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }),
  );
  yield* Effect.annotateCurrentSpan("process.exit_code", Number(status));
  if (Number(status) !== 0)
    return yield* new ServiceError({
      operation: "launch",
      message: `chown exited with ${String(status)} while handing ${target} to '${user.name}'`,
    });
});

/**
 * Hands the instance data, key, socket, HBA file, the bundle's getkey script, and a confined
 * native `environmentHome` (if any) to the PostgreSQL user, each with its own `chown -R -P` call
 * so a nested directory is never also listed as a separate, redundant target. `runtimeRoot` and its
 * ancestors only gain traverse, so the step-down user reaches its socket directory under a
 * restrictive configured base without write access to any of them. An ancestor inside the
 * published generation (the bundle root and anything between it and the executable or getkey)
 * is only required to already have traverse, never granted it: that generation is immutable.
 */
export const handOverNativePostgresFiles = Effect.fn("NativePostgresUser.handOverFiles")(function* (
  user: PasswdEntry,
  paths: {
    readonly dataPath: string;
    readonly rootKeyPath: string;
    readonly socketPath: string;
    readonly hbaPath: string;
    readonly runtimeRoot: string;
    readonly bundleRoot: string;
    readonly executable: string;
    /** A confined native environment root (HOME); chowned on its own, never as a nested target. */
    readonly environmentHome?: string;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const getkey = path.join(paths.bundleRoot, GETKEY_SCRIPT);
  const hasGetkey = yield* fs.exists(getkey);
  const targets = [paths.dataPath, paths.rootKeyPath, paths.socketPath, paths.hbaPath];
  if (hasGetkey) {
    yield* requireOwnedByRootOr(user, getkey);
    targets.push(getkey);
  }
  for (const target of targets) yield* chownRecursive(user, target);
  if (paths.environmentHome !== undefined) {
    // A prior launch's confined HOME could have been replaced by a symlink or junction between
    // runs; refuse to chown through it rather than trust reuse.
    if ((yield* lstatPath(paths.environmentHome))?.type === "SymbolicLink")
      return yield* new ServiceError({
        operation: "launch",
        message: `${paths.environmentHome} is a symlink; refusing to hand it to '${user.name}'`,
      });
    yield* chownRecursive(user, paths.environmentHome);
  }
  const insideGeneration = (candidate: string) =>
    candidate === paths.bundleRoot || candidate.startsWith(`${paths.bundleRoot}${path.sep}`);
  const executableAncestors = ancestorsOf(path, path.dirname(paths.executable));
  const getkeyAncestors = hasGetkey ? ancestorsOf(path, path.dirname(getkey)) : [];
  yield* requireTraverse([
    ...executableAncestors.filter(insideGeneration),
    ...getkeyAncestors.filter(insideGeneration),
  ]);
  yield* allowTraverse(user, [
    ...ancestorsOf(path, paths.runtimeRoot),
    ...executableAncestors.filter((candidate) => !insideGeneration(candidate)),
    ...getkeyAncestors.filter((candidate) => !insideGeneration(candidate)),
  ]);
});
