import { BunChildProcessSpawner, BunFileSystem, BunPath } from "@effect/platform-bun";
import {
  Cause,
  Clock,
  Console,
  Data,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Schedule,
  Schema,
  Stream,
} from "effect";
import type { PlatformError } from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { runSupabase } from "./cli.ts";

type TempHome = {
  readonly dir: string;
  readonly dispose: () => void | Promise<void>;
};

type StackProject = {
  readonly dir: string;
  readonly cleanup: () => Promise<void>;
  homeDir?: string;
};

interface StackRuntimeSnapshot {
  readonly managedStacksRootExists: boolean;
  readonly documentFiles: ReadonlyArray<string>;
  readonly stackDirs: ReadonlyArray<string>;
  readonly trackedPids: ReadonlyArray<number>;
}

type MaybePromise<A> = A | PromiseLike<A>;

interface CleanupEnvironment {
  readonly stopStack: (projectDir: string, homeDir: string) => Promise<{ exitCode: number }>;
  readonly captureSnapshot: (
    projectDir: string,
    homeDir?: string,
  ) => MaybePromise<StackRuntimeSnapshot>;
  readonly waitForCleanup: (
    projectDir: string,
    homeDir: string | undefined,
    snapshot: StackRuntimeSnapshot,
  ) => Promise<boolean>;
  readonly forceCleanup: (
    projectDir: string,
    homeDir: string | undefined,
    snapshot: StackRuntimeSnapshot,
  ) => Promise<void>;
  readonly removeProjectWithDocker: (projectDir: string) => Promise<boolean>;
  readonly repairProjectPermissions: (projectDir: string) => MaybePromise<void>;
  readonly describeProjectPermissions: (projectDir: string) => MaybePromise<string>;
}

interface StackE2eCleanupManager {
  registerHome(home: TempHome): void;
  registerStackProject(project: {
    readonly dir: string;
    readonly cleanup: () => Promise<void>;
  }): void;
  associateHome(projectDir: string, homeDir: string): void;
  drain(): Promise<void>;
  reset(): void;
}

type HostServices = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner;

const hostLayer: Layer.Layer<HostServices> = BunChildProcessSpawner.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)),
);

/* Promise edge of the real environment: a host failure rejects with the original error. */
const runHost = <A>(effect: Effect.Effect<A, PlatformError, HostServices>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.catch((error) => Effect.die(error.cause ?? error)),
      Effect.provide(hostLayer),
    ),
  );

/** A foreign cleanup callback or environment member rejected or threw. */
class CleanupForeignFailure extends Data.TaggedError("CleanupForeignFailure")<{
  readonly cause: unknown;
}> {}

/** An owned path could not be removed; `detail` is the reported reason. */
class OwnedPathCleanupFailure extends Data.TaggedError("OwnedPathCleanupFailure")<{
  readonly detail: string;
}> {}

const callForeign = <A>(run: () => MaybePromise<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(run()),
    catch: (cause) => new CleanupForeignFailure({ cause }),
  });

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const foreignMessage = (error: PlatformError) => errorMessage(error.cause ?? error);

const normalizeDir = Effect.fnUntraced(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolved = path.resolve(dir);
  return yield* fs.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved));
});

const pathExists = Effect.fnUntraced(function* (pathname: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.exists(pathname).pipe(Effect.orElseSucceed(() => false));
});

/*
 * Directory entries never follow symlinks. `FileSystem` has no `lstat`, so `readLink` decides: only
 * its "not a symlink" answer (`EINVAL`) lets `stat` judge the entry; a link, or an entry `readLink`
 * is denied on (a mode-000 link on macOS), is never walked.
 */
const isDirectoryEntry = Effect.fnUntraced(function* (pathname: string) {
  const fs = yield* FileSystem.FileSystem;
  const notASymlink = yield* fs.readLink(pathname).pipe(
    Effect.as(false),
    Effect.catchTag("PlatformError", (error) =>
      Effect.succeed(Predicate.hasProperty(error.cause, "code") && error.cause.code === "EINVAL"),
    ),
  );
  if (!notASymlink) {
    return false;
  }
  return yield* fs.stat(pathname).pipe(
    Effect.map((info) => info.type === "Directory"),
    Effect.orElseSucceed(() => false),
  );
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killQuietly(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}

function parsePsOutput(output: string): Array<{
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
}> {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (match == null) {
        return undefined;
      }
      return {
        pid: Number.parseInt(match[1]!, 10),
        ppid: Number.parseInt(match[2]!, 10),
        command: match[3] ?? "",
      };
    })
    .filter(
      (entry): entry is { readonly pid: number; readonly ppid: number; readonly command: string } =>
        entry != null,
    );
}

/** The output limit of a synchronous spawn: its default 1 MiB `maxBuffer`. */
const SYNC_SPAWN_MAX_BUFFER = 1024 * 1024;

/** The most a synchronous spawn reads from a pipe at once. */
const SYNC_SPAWN_READ_SIZE = 64 * 1024;

/** The output outgrew the synchronous-spawn buffer limit. */
class OutputBufferExceeded extends Data.TaggedError("OutputBufferExceeded")<{
  readonly bytes: Uint8Array;
}> {}

const concatBytes = (chunks: ReadonlyArray<Uint8Array>, size: number) => {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

/**
 * Buffers a stream the way a synchronous spawn does: once the total passes the limit it stops
 * with what was read so far, the chunk that crossed the limit included.
 */
const collectBounded = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  Effect.suspend(() => {
    const chunks: Array<Uint8Array> = [];
    let size = 0;
    return Stream.runForEach(stream, (chunk) =>
      Effect.suspend(() => {
        chunks.push(chunk);
        size += chunk.byteLength;
        return size > SYNC_SPAWN_MAX_BUFFER
          ? Effect.fail(new OutputBufferExceeded({ bytes: concatBytes(chunks, size) }))
          : Effect.void;
      }),
    ).pipe(Effect.map(() => concatBytes(chunks, size)));
  });

/* Recovers every failure a spawn can raise, its throws included; interruption passes through. */
const recoverUnlessInterrupted = <A, E, R, B>(
  effect: Effect.Effect<A, E, R>,
  recover: (failure: unknown) => B,
): Effect.Effect<A | B, never, R> =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(Cause.fromReasons(cause.reasons.filter(Cause.isInterruptReason)))
        : Effect.succeed(recover(Cause.squash(cause))),
    ),
  );

const parsePsTable = recoverUnlessInterrupted(
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const output = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make("ps", ["-Ao", "pid=,ppid=,command="], {
            /* A plain child, not a process group: no process-group signals. */
            detached: false,
            stdin: "ignore",
            stderr: "ignore",
          }),
        );
        const [bytes, exitCode] = yield* Effect.all(
          [collectBounded(handle.stdout), handle.exitCode],
          { concurrency: "unbounded" },
        );
        return exitCode === 0 ? Option.some(utf8.decode(bytes)) : Option.none<string>();
      }),
    );
    return Option.match(output, { onNone: () => [], onSome: parsePsOutput });
  }),
  () => [],
);

function descendantPids(
  rootPids: ReadonlyArray<unknown>,
  table: ReadonlyArray<{ readonly pid: number; readonly ppid: number }>,
): Array<unknown> {
  const visited = new Set<unknown>();
  const pending = [...rootPids];

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    for (const row of table) {
      if (row.ppid === current) {
        pending.push(row.pid);
      }
    }
  }

  return [...visited];
}

const decodeStackWorkspace = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      workspace: Schema.optional(Schema.Struct({ path: Schema.optional(Schema.String) })),
    }),
  ),
);

const decodeJsonDocument = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/* Reads UTF-8 text and keeps a leading byte order mark, like `readFileSync(path, "utf8")`. */
const utf8 = new TextDecoder("utf-8", { ignoreBOM: true });
const readUtf8 = (fs: FileSystem.FileSystem, pathname: string) =>
  fs.readFile(pathname).pipe(Effect.map((bytes) => utf8.decode(bytes)));

const readWorkspacePath = Effect.fnUntraced(function* (documentFile: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* readUtf8(fs, documentFile).pipe(
    Effect.flatMap(decodeStackWorkspace),
    Effect.map((document) => document.workspace?.path),
    Effect.orElseSucceed(() => undefined),
  );
});

const readDocumentPid = Effect.fnUntraced(function* (documentFile: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* readUtf8(fs, documentFile).pipe(
    Effect.flatMap(decodeJsonDocument),
    /* `runtime.pid` as written, whatever its JSON type, like a plain property read. */
    Effect.map((document) => {
      const runtime = Predicate.hasProperty(document, "runtime") ? document.runtime : undefined;
      return Predicate.hasProperty(runtime, "pid") ? runtime.pid : undefined;
    }),
    Effect.orElseSucceed(() => undefined),
  );
});

function cleanupErrorDetail(pathname: string, detail: string, resource = "temp stack project") {
  return `Failed to remove ${resource} ${pathname}: ${detail}`;
}

// Walks the `cause` chain so a typed wrapper classifies by the errno it carries.
function isPermissionError(error: unknown, hops = 8): boolean {
  let current: unknown = error;
  for (let hop = 0; hop < hops && current != null && typeof current === "object"; hop += 1) {
    const code = "code" in current ? String(current.code) : undefined;
    if (code === "EACCES" || code === "EPERM") {
      return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

function formatMode(mode: number): string {
  return `0${(mode & 0o777).toString(8)}`;
}

const describePath = Effect.fnUntraced(function* (pathname: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.stat(pathname).pipe(
    Effect.map(
      (stats) =>
        `${pathname} uid=${Option.getOrUndefined(stats.uid)} gid=${Option.getOrUndefined(stats.gid)} mode=${formatMode(stats.mode)}`,
    ),
    Effect.catch((error) => Effect.succeed(`${pathname} ${foreignMessage(error)}`)),
  );
});

const describeProjectPermissions = Effect.fnUntraced(function* (projectDir: string) {
  const path = yield* Path.Path;
  const details = [
    "Permission diagnostics:",
    yield* describePath(projectDir),
    yield* describePath(path.join(projectDir, ".supabase")),
  ];
  return details.join("\n");
});

const repairProjectPermissions = Effect.fnUntraced(function* (projectDir: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  yield* spawner
    .exitCode(
      ChildProcess.make("chmod", ["-R", "u+rwX", projectDir], {
        detached: false,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }),
    )
    .pipe(Effect.timeoutOption(5_000), (run) => recoverUnlessInterrupted(run, () => undefined));
});

const removeProjectWithDocker = Effect.fnUntraced(function* (projectDir: string) {
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const args = [
    "run",
    "--rm",
    "--user",
    "0:0",
    "-v",
    `${path.dirname(projectDir)}:/parent`,
    "-e",
    `TARGET_NAME=${path.basename(projectDir)}`,
    "--entrypoint",
    "sh",
    "public.ecr.aws/docker/library/busybox:1.36",
    "-c",
    'cd /parent && rm -rf -- "$TARGET_NAME"',
  ];

  /* The stderr read so far, kept across a timeout or an outgrown buffer for the report. */
  const stderrChunks: Array<Uint8Array> = [];
  let stderrSize = 0;
  const failure = yield* recoverUnlessInterrupted(
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make("docker", args, {
            /* A plain child, not a process group: its descendants are left alone. */
            detached: false,
            stdin: "ignore",
            stdout: "ignore",
            stderr: "pipe",
          }),
        );
        const [, exitCode] = yield* Effect.all(
          [
            Stream.runForEach(handle.stderr, (chunk) =>
              Effect.suspend(() => {
                stderrChunks.push(chunk);
                stderrSize += chunk.byteLength;
                return stderrSize > SYNC_SPAWN_MAX_BUFFER
                  ? Effect.fail(new OutputBufferExceeded({ bytes: new Uint8Array() }))
                  : Effect.void;
              }),
            ),
            /* A signal death fails like a nonzero exit. */
            handle.exitCode.pipe(Effect.orElseSucceed(() => -1)),
          ],
          { concurrency: "unbounded" },
        );
        return exitCode;
      }),
    ).pipe(
      Effect.timeoutOption(30_000),
      Effect.map(
        Option.match({
          onNone: () => "spawnSync docker ETIMEDOUT",
          onSome: (exitCode) =>
            exitCode === 0 ? undefined : `Command failed: docker ${args.join(" ")}`,
        }),
      ),
      Effect.catchTag("OutputBufferExceeded", () =>
        Effect.succeed(
          "spawnSync docker ENOBUFS (stdout or stderr buffer reached maxBuffer size limit)",
        ),
      ),
    ),
    (thrown) =>
      errorMessage(
        Predicate.isTagged(thrown, "PlatformError") && Predicate.hasProperty(thrown, "cause")
          ? thrown.cause
          : thrown,
      ),
  );
  /* A synchronous spawn reads in 64 KiB pieces, so an outgrown buffer keeps through the piece that
     crossed the limit. */
  const keptSize = Math.min(stderrSize, SYNC_SPAWN_MAX_BUFFER + SYNC_SPAWN_READ_SIZE);
  const stderr = new TextDecoder().decode(
    concatBytes(stderrChunks, stderrSize).subarray(0, keptSize),
  );
  const dockerErr = failure === undefined ? undefined : stderr.trim() || failure;

  const removed = !(yield* pathExists(projectDir));
  if (!removed && dockerErr) {
    yield* Console.warn(
      `[stack-e2e-cleanup] docker fallback for ${projectDir} failed: ${dockerErr}`,
    );
  }
  return removed;
});

type PermissionFallback = Pick<
  CleanupEnvironment,
  "removeProjectWithDocker" | "repairProjectPermissions" | "describeProjectPermissions"
>;

const reportedAs = <A>(run: () => MaybePromise<A>) =>
  callForeign(run).pipe(
    Effect.mapError(
      (failure) => new OwnedPathCleanupFailure({ detail: errorMessage(failure.cause) }),
    ),
  );

const recoverPermissionBlockedPath = Effect.fnUntraced(function* (
  pathname: string,
  cleanup: () => void | Promise<void>,
  environment: PermissionFallback,
) {
  const removedByDocker = yield* reportedAs(() => environment.removeProjectWithDocker(pathname));
  if (removedByDocker) {
    return;
  }

  yield* reportedAs(() => environment.repairProjectPermissions(pathname));
  yield* callForeign(cleanup).pipe(
    Effect.catch((retryFailure) =>
      reportedAs(() => environment.describeProjectPermissions(pathname)).pipe(
        Effect.flatMap((diagnostics) =>
          Effect.fail(
            new OwnedPathCleanupFailure({
              detail: `${errorMessage(retryFailure.cause)}\n${diagnostics}`,
            }),
          ),
        ),
      ),
    ),
  );
});

const cleanupOwnedPath = (
  pathname: string,
  cleanup: () => void | Promise<void>,
  environment: PermissionFallback,
) =>
  callForeign(cleanup).pipe(
    Effect.catch((failure) =>
      isPermissionError(failure.cause)
        ? recoverPermissionBlockedPath(pathname, cleanup, environment)
        : Effect.fail(new OwnedPathCleanupFailure({ detail: errorMessage(failure.cause) })),
    ),
  );

const captureSnapshot = Effect.fnUntraced(function* (projectDir: string, homeDir?: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const normalized = yield* normalizeDir(projectDir);
  const managedStacksRoot =
    homeDir === undefined ? undefined : path.join(yield* normalizeDir(homeDir), "stacks");
  if (managedStacksRoot === undefined || !(yield* pathExists(managedStacksRoot))) {
    return {
      managedStacksRootExists: false,
      documentFiles: [],
      stackDirs: [],
      trackedPids: [],
    } satisfies StackRuntimeSnapshot;
  }

  const stackDirs: Array<string> = [];
  const documentFiles: Array<string> = [];

  for (const entry of yield* fs.readDirectory(managedStacksRoot)) {
    const stackDir = path.join(managedStacksRoot, entry);
    if (!(yield* isDirectoryEntry(stackDir))) {
      continue;
    }
    const documentFile = path.join(stackDir, "stack.json");
    if (!(yield* pathExists(documentFile))) {
      continue;
    }
    const workspacePath = yield* readWorkspacePath(documentFile);
    if (workspacePath === undefined || (yield* normalizeDir(workspacePath)) !== normalized) {
      continue;
    }
    stackDirs.push(stackDir);
    documentFiles.push(documentFile);
  }

  /* A pid is kept as written when it compares above zero; only a numeric one matches a `ps` row,
     and process signals coerce the others to numbers. */
  const rootPids: Array<unknown> = [];
  for (const documentFile of documentFiles) {
    const pid = yield* readDocumentPid(documentFile);
    if (pid != null && Number(pid) > 0) {
      rootPids.push(pid);
    }
  }
  const table = yield* parsePsTable;
  const descendants = descendantPids(rootPids, table);
  const commandPids = table.filter((row) => row.command.includes(normalized)).map((row) => row.pid);

  return {
    managedStacksRootExists: stackDirs.length > 0,
    documentFiles,
    stackDirs,
    trackedPids: [...new Set([...descendants, ...commandPids])]
      .sort((left, right) => Number(left) - Number(right))
      .map(Number),
  } satisfies StackRuntimeSnapshot;
});

type CleanupRound = "clean" | "pending" | "expired";

const waitForCleanup = Effect.fnUntraced(function* (
  projectDir: string,
  homeDir: string | undefined,
  snapshot: StackRuntimeSnapshot,
) {
  const deadline = (yield* Clock.currentTimeMillis) + 15_000;
  /* Each round checks the deadline before it looks; a round that still sees the stack waits 200 ms. */
  const round = Effect.flatMap(Clock.currentTimeMillis, (now) =>
    now < deadline
      ? Effect.map(captureSnapshot(projectDir, homeDir), (nextSnapshot): CleanupRound => {
          const filesGone = nextSnapshot.documentFiles.length === 0;
          const pidsGone = snapshot.trackedPids.every((pid) => !isProcessAlive(pid));
          return filesGone && pidsGone ? "clean" : "pending";
        })
      : Effect.succeed<CleanupRound>("expired"),
  );
  const state = yield* round.pipe(
    Effect.repeat({ schedule: Schedule.spaced(200), while: (current) => current === "pending" }),
  );
  return state === "clean";
});

const forceCleanup = Effect.fnUntraced(function* (snapshot: StackRuntimeSnapshot) {
  const fs = yield* FileSystem.FileSystem;
  for (const pid of snapshot.trackedPids) {
    killQuietly(pid);
  }

  for (const stackDir of snapshot.stackDirs) {
    yield* fs.remove(stackDir, { recursive: true, force: true }).pipe(Effect.ignore);
  }
});

function createRealEnvironment(): CleanupEnvironment {
  return {
    stopStack: (projectDir, homeDir) =>
      runSupabase(["stack", "destroy", "--yes"], {
        cwd: projectDir,
        home: homeDir,
        env: { SUPABASE_EXPERIMENTAL_STACK: "1" },
        exitTimeoutMs: 15_000,
      }).then((result) => ({ exitCode: result.exitCode })),
    captureSnapshot: (projectDir, homeDir) => runHost(captureSnapshot(projectDir, homeDir)),
    waitForCleanup: (projectDir, homeDir, snapshot) =>
      runHost(waitForCleanup(projectDir, homeDir, snapshot)),
    forceCleanup: (_projectDir, _homeDir, snapshot) => runHost(forceCleanup(snapshot)),
    removeProjectWithDocker: (projectDir) => runHost(removeProjectWithDocker(projectDir)),
    repairProjectPermissions: (projectDir) => runHost(repairProjectPermissions(projectDir)),
    describeProjectPermissions: (projectDir) => runHost(describeProjectPermissions(projectDir)),
  };
}

type Registration =
  | {
      readonly kind: "home";
      readonly dir: Fiber.Fiber<string>;
      readonly dispose: () => void | Promise<void>;
    }
  | {
      readonly kind: "project";
      readonly dir: Fiber.Fiber<string>;
      readonly cleanup: () => Promise<void>;
    }
  | {
      readonly kind: "association";
      readonly projectDir: Fiber.Fiber<string>;
      readonly homeDir: Fiber.Fiber<string>;
    };

/* Registration stays synchronous, so canonicalization starts now, while the owned path exists. */
const startNormalizeDir = (dir: string): Fiber.Fiber<string> =>
  Effect.runFork(normalizeDir(dir).pipe(Effect.provide(hostLayer)));

/* Replays registrations in order into maps keyed by canonical dir. */
const resolveRegistrations = Effect.fnUntraced(function* (
  registrations: ReadonlyArray<Registration>,
) {
  const homes = new Map<string, TempHome>();
  const projects = new Map<string, StackProject>();
  for (const registration of registrations) {
    switch (registration.kind) {
      case "home": {
        const dir = yield* Fiber.join(registration.dir);
        homes.set(dir, { dir, dispose: registration.dispose });
        break;
      }
      case "project": {
        const dir = yield* Fiber.join(registration.dir);
        projects.set(dir, { dir, cleanup: registration.cleanup });
        break;
      }
      case "association": {
        const project = projects.get(yield* Fiber.join(registration.projectDir));
        if (project !== undefined) {
          project.homeDir = yield* Fiber.join(registration.homeDir);
        }
        break;
      }
    }
  }
  return { pendingProjects: [...projects.values()], pendingHomes: homes };
});

const drainRegistrations = Effect.fnUntraced(function* (
  environment: CleanupEnvironment,
  registrations: ReadonlyArray<Registration>,
) {
  const { pendingProjects, pendingHomes } = yield* resolveRegistrations(registrations);

  const failures: Array<string> = [];
  const associatedHomes = new Map<string, TempHome>();

  for (const project of pendingProjects) {
    const homeDir = project.homeDir;
    const home = homeDir === undefined ? undefined : pendingHomes.get(homeDir);
    if (home !== undefined && homeDir !== undefined) {
      associatedHomes.set(homeDir, home);
    }
    const snapshot = yield* callForeign(() =>
      environment.captureSnapshot(project.dir, project.homeDir),
    );
    const hasRuntimeArtifacts =
      snapshot.documentFiles.length > 0 || snapshot.trackedPids.some((pid) => isProcessAlive(pid));
    const hasStackPersistence = snapshot.managedStacksRootExists || snapshot.stackDirs.length > 0;
    let stopExitCode: number | undefined;

    const stackHomeDir = project.homeDir;
    if (hasStackPersistence && stackHomeDir !== undefined) {
      stopExitCode = yield* callForeign(() =>
        environment.stopStack(project.dir, stackHomeDir),
      ).pipe(
        Effect.map((stopResult) => stopResult.exitCode),
        Effect.orElseSucceed(() => 1),
      );
    }

    if (hasRuntimeArtifacts) {
      const cleaned = yield* callForeign(() =>
        environment.waitForCleanup(project.dir, project.homeDir, snapshot),
      );
      if (!cleaned) {
        yield* callForeign(() => environment.forceCleanup(project.dir, project.homeDir, snapshot));
        failures.push(
          stopExitCode != null && stopExitCode !== 0
            ? `Centralized e2e cleanup detected leaked stack resources for ${project.dir} after stop exited ${stopExitCode}.`
            : `Centralized e2e cleanup detected leaked stack resources for ${project.dir}.`,
        );
      }
    }

    yield* cleanupOwnedPath(project.dir, project.cleanup, environment).pipe(
      Effect.catch((failure) =>
        Effect.sync(() => {
          failures.push(cleanupErrorDetail(project.dir, failure.detail));
        }),
      ),
    );
  }

  for (const home of associatedHomes.values()) {
    yield* cleanupOwnedPath(home.dir, home.dispose, environment).pipe(
      Effect.catch((failure) =>
        Effect.sync(() => {
          failures.push(cleanupErrorDetail(home.dir, failure.detail, "temp home"));
        }),
      ),
    );
  }

  // Cleanup failures are best-effort and don't fail the test: assertions already
  // ran, CI runners are ephemeral, and cases like `functions dev`'s root-owned
  // docker files can make cleanup itself impossible.
  if (failures.length > 0) {
    yield* Console.warn(
      `[stack-e2e-cleanup] ${failures.length} resource(s) could not be cleaned up:\n${failures.join("\n")}`,
    );
  }
});

export function createStackE2eCleanupManager(
  environment: CleanupEnvironment = createRealEnvironment(),
): StackE2eCleanupManager {
  let registrations: Array<Registration> = [];

  return {
    registerHome(home) {
      registrations.push({
        kind: "home",
        dir: startNormalizeDir(home.dir),
        dispose: () => home.dispose(),
      });
    },
    registerStackProject(project) {
      registrations.push({
        kind: "project",
        dir: startNormalizeDir(project.dir),
        cleanup: () => project.cleanup(),
      });
    },
    associateHome(projectDir, homeDir) {
      /* With no stack project registered yet there is nothing to associate, so nothing is kept. */
      if (!registrations.some((registration) => registration.kind === "project")) {
        return;
      }
      registrations.push({
        kind: "association",
        projectDir: startNormalizeDir(projectDir),
        homeDir: startNormalizeDir(homeDir),
      });
    },
    drain() {
      const pending = registrations;
      registrations = [];
      /* A foreign rejection rejects the drain with the original value. */
      return Effect.runPromise(
        drainRegistrations(environment, pending).pipe(
          Effect.catch((failure) => Effect.die(failure.cause)),
        ),
      );
    },
    reset() {
      registrations = [];
    },
  };
}

const manager = createStackE2eCleanupManager();

export function registerTempHome(home: {
  readonly dir: string;
  readonly dispose: () => Promise<void>;
}): void {
  manager.registerHome(home);
}

export function registerTempStackProject(project: {
  readonly dir: string;
  readonly cleanup: () => Promise<void>;
}): void {
  manager.registerStackProject(project);
}

export function noteStackCliProjectHome(projectDir: string | undefined, homeDir: string): void {
  if (projectDir === undefined) {
    return;
  }
  manager.associateHome(projectDir, homeDir);
}

export function cleanupRegisteredStackProjects(): Promise<void> {
  return manager.drain();
}
