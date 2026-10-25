import { BunServices } from "@effect/platform-bun";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type * as PlatformError from "effect/PlatformError";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  Config,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Path,
  Predicate,
  PubSub,
  Schema,
  Scope,
  Stream,
} from "effect";
import {
  noteStackCliProjectHome,
  registerTempHome,
  registerTempStackProject,
} from "./stack-e2e-cleanup.ts";

export { stripAnsi } from "./ansi.ts";

const BINARY_EXT = process.platform === "win32" ? ".exe" : "";
const SHIM_PATH = fileURLToPath(new URL("../../dist/supabase.js", import.meta.url));
const BINARY_PATH = fileURLToPath(new URL(`../../dist/supabase${BINARY_EXT}`, import.meta.url));

// E2E subprocesses should only enter agent output mode when a test explicitly
// opts in via `options.env`. Keep this list aligned with @vercel/detect-agent
// env probes so a developer's shell cannot accidentally change CLI rendering.
const AGENT_DETECTION_ENV_KEYS: readonly string[] = [
  "AI_AGENT",
  "CURSOR_TRACE_ID",
  "CURSOR_AGENT",
  "CURSOR_EXTENSION_HOST_ROLE",
  "GEMINI_CLI",
  "CODEX_SANDBOX",
  "CODEX_CI",
  "CODEX_THREAD_ID",
  "ANTIGRAVITY_AGENT",
  "AUGMENT_AGENT",
  "OPENCODE_CLIENT",
  "CLAUDECODE",
  "CLAUDE_CODE",
  "CLAUDE_CODE_IS_COWORK",
  "REPL_ID",
  "COPILOT_MODEL",
  "COPILOT_ALLOW_ALL",
  "COPILOT_GITHUB_TOKEN",
];

function subprocessBaseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const key of AGENT_DETECTION_ENV_KEYS) delete env[key];
  // Keep test spawns hermetic: never let the upgrade notice hit GitHub or
  // print into asserted output. Tests exercising the notice override this.
  env["SUPABASE_NO_UPDATE_NOTIFIER"] = "1";
  return env;
}

export type RunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Set when the harness exit bound fired and SIGKILLed the process group. */
  timedOutAfterMs?: number;
};

/** The CLI closed its stdin before the harness finished writing to it. */
class CliStdinWriteError extends Data.TaggedError("CliStdinWriteError")<{
  readonly cause: Error;
}> {
  override get message(): string {
    return this.cause.message;
  }
}

/** Spawning the CLI failed before the child was usable. */
class CliSpawnError extends Data.TaggedError("CliSpawnError")<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return this.cause instanceof Error ? this.cause.message : String(this.cause);
  }
}

/** The compiled CLI is missing, so there is nothing to spawn. */
class CliBuildArtifactsError extends Data.TaggedError("CliBuildArtifactsError")<{
  readonly message: string;
}> {}

/** Disposing a run-owned or test-owned temp `SUPABASE_HOME` failed. */
export class CliHomeDisposeError extends Data.TaggedError("CliHomeDisposeError")<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return this.cause instanceof Error ? this.cause.message : String(this.cause);
  }
}

export type CliRunError = CliSpawnError | CliStdinWriteError | CliHomeDisposeError;

/** The CLI exited, or the wait timed out, before its stdout matched. */
class CliOutputWaitError extends Data.TaggedError("CliOutputWaitError")<{
  readonly message: string;
}> {}

/** No free port could be allocated for this e2e worker. */
class E2ePortError extends Data.TaggedError("E2ePortError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Stopping the stack of an owned temp project failed. */
class TempStackCleanupError extends Data.TaggedError("TempStackCleanupError")<{
  readonly message: string;
}> {}

const helperServices = BunServices.layer;

/* UTF-8 decoding that keeps a leading byte order mark, like Node's `Buffer#toString`. */
const chunkDecoder = new TextDecoder("utf-8", { ignoreBOM: true });

/** The host error a platform failure carries, which is what the file system call raised. */
const hostCause = (error: PlatformError.PlatformError): unknown => error.cause ?? error;

/* A platform or port failure's host error, else a plain `Error` with the failure's message. */
function hostOrPlainError(error: Error): Error {
  if (Predicate.isTagged(error, "PlatformError") || error instanceof E2ePortError) {
    return error.cause instanceof Error ? error.cause : new Error(error.message);
  }
  if (
    error instanceof TempStackCleanupError ||
    error instanceof CliOutputWaitError ||
    error instanceof CliBuildArtifactsError
  ) {
    return new Error(error.message);
  }
  return error;
}

/**
 * What a Promise helper rejects with: the host error a platform or port failure carries, else a
 * plain `Error` with the failure's message. A home disposal failure stays typed.
 */
export function helperRejection(error: Error): Error {
  if (error instanceof CliHomeDisposeError) {
    return error;
  }
  if (error instanceof CliSpawnError || error instanceof CliStdinWriteError) {
    return error.cause instanceof Error ? hostOrPlainError(error.cause) : new Error(error.message);
  }
  return hostOrPlainError(error);
}

/** Promise edge for the helpers non-Effect tests `await`. */
const runHelper = <A, E extends Error>(
  effect: Effect.Effect<A, E, BunServices.BunServices>,
): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.mapError(helperRejection), Effect.provide(helperServices)));

const removeOwnedDir = (dir: string) =>
  FileSystem.FileSystem.use((fs) => fs.remove(dir, { recursive: true, force: true }));

/** Like `existsSync`: any failure to reach the path reads as "absent". */
const pathExists = (fs: FileSystem.FileSystem, pathname: string) =>
  fs.exists(pathname).pipe(Effect.orElseSucceed(() => false));

const DEFAULT_EXIT_TIMEOUT_MS = 60_000;
const DEFAULT_STACK_CLEANUP_TIMEOUT_MS = 120_000;
const OUTPUT_TAIL_LENGTH = 4_000;

/** A temp `SUPABASE_HOME`; `dispose` removes it (repeatably) and keeps failures typed. */
export interface TempHome {
  readonly dir: string;
  readonly dispose: Effect.Effect<void, CliHomeDisposeError>;
}

/** The run's owned temp `SUPABASE_HOME` could not be created. */
export class TempHomeSetupError extends Data.TaggedError("TempHomeSetupError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

const createTempHomeEffect = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectory({
    directory: process.platform === "win32" ? tmpdir() : "/tmp",
    prefix: "sb-test-",
  });

  // Share the real binary cache so tests don't re-download binaries.
  const realBinDir = path.join(homedir(), ".supabase", "bin");
  if (yield* pathExists(fs, realBinDir)) {
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.symlink(realBinDir, path.join(dir, "bin"));
  }

  const context = yield* Effect.context<FileSystem.FileSystem>();
  const dispose = removeOwnedDir(dir).pipe(
    Effect.mapError((cause) => new CliHomeDisposeError({ cause: hostCause(cause) })),
    Effect.provide(context),
  );
  const home: TempHome = { dir, dispose };
  yield* Effect.sync(() =>
    registerTempHome({
      dir,
      dispose: () =>
        Effect.runPromiseWith(context)(removeOwnedDir(dir).pipe(Effect.mapError(helperRejection))),
    }),
  );
  return home;
});

/**
 * Creates and registers a temp `SUPABASE_HOME` without a release: the caller disposes it, or
 * the e2e cleanup drain does when a stack project uses it.
 */
export const createTempHome: Effect.Effect<TempHome, TempHomeSetupError> =
  createTempHomeEffect.pipe(
    Effect.mapError(
      (cause) =>
        new TempHomeSetupError({ message: "temp home setup failed", cause: hostCause(cause) }),
    ),
    Effect.provide(helperServices),
  );

/** A temp `SUPABASE_HOME` owned by the calling scope, removed when the scope closes. */
export const makeTempHome: Effect.Effect<TempHome, TempHomeSetupError, Scope.Scope> =
  Effect.acquireRelease(createTempHome, (home) => Effect.orDie(home.dispose));

/**
 * Runs `use` with an owned temp `SUPABASE_HOME`. Setup and disposal failures both stay in
 * the typed channel, which a scoped release could not express.
 */
export const withTempHome = <A, E, R>(
  use: (home: TempHome) => Effect.Effect<A, E, R>,
): Effect.Effect<A, TempHomeSetupError | CliHomeDisposeError | E, R> =>
  Effect.acquireUseRelease(createTempHome, use, (owned) => owned.dispose);

/** The run's owned temp CLI project could not be created or removed. */
export class TempCliProjectError extends Data.TaggedError("TempCliProjectError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

/**
 * Runs `use` with an owned temp CLI project from `makeTempCliProject`, which keeps its stack
 * cleanup registration. Setup and removal failures both stay in the typed channel.
 */
export const withTempCliProject = <A, E, R>(
  prefix: string,
  use: (project: Awaited<ReturnType<typeof makeTempCliProject>>) => Effect.Effect<A, E, R>,
): Effect.Effect<A, TempCliProjectError | E, R> =>
  Effect.acquireUseRelease(
    makeTempCliProjectEffect(prefix).pipe(
      Effect.provide(helperServices),
      Effect.mapError(
        (cause) =>
          new TempCliProjectError({
            message: "temp CLI project setup failed",
            cause: hostCause(cause),
          }),
      ),
    ),
    use,
    (project) =>
      removeOwnedDir(project.dir).pipe(
        Effect.provide(helperServices),
        Effect.mapError(
          (cause) =>
            new TempCliProjectError({
              message: "temp CLI project cleanup failed",
              cause: hostCause(cause),
            }),
        ),
      ),
  );

const portError = (error: Error) => new E2ePortError({ message: error.message, cause: error });

const pickReleasedPort = Effect.callback<number, E2ePortError>((resume) => {
  const server = createServer();
  let settled = false;
  const settle = (result: Effect.Effect<number, E2ePortError>) => {
    if (settled) return;
    settled = true;
    resume(result);
  };
  /* Stays attached after cancellation so a late listen error is never an unhandled event. */
  server.on("error", (error) => settle(Effect.fail(portError(error))));
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address == null || typeof address === "string") {
      server.close(() =>
        settle(Effect.fail(new E2ePortError({ message: "Failed to allocate a free port" }))),
      );
      return;
    }
    server.close((error) => {
      settle(error ? Effect.fail(portError(error)) : Effect.succeed(address.port));
    });
  });
  return Effect.sync(() => {
    settled = true;
    server.close();
  });
});

/**
 * Concurrent e2e workers each keep only ports in their own slot, so a port one worker picked and
 * released before Docker binds it is never handed to another worker. Slots skip the low bit
 * because Linux hands out mostly odd ports for `listen(0)`.
 */
const envOrEmpty = (name: string) => Config.String(name).pipe(Config.withDefault(""));

const pickFreePort = Effect.gen(function* () {
  const e2eWorkers = Number((yield* envOrEmpty("SUPABASE_E2E_WORKERS")) || "1");
  const e2eWorkerSlot = Number((yield* envOrEmpty("VITEST_POOL_ID")) || "1") % e2eWorkers;
  for (let attempt = 0; attempt < 1000; attempt++) {
    const port = yield* pickReleasedPort;
    if (Math.floor(port / 2) % e2eWorkers === e2eWorkerSlot) return port;
  }
  return yield* new E2ePortError({
    message: `No free port for e2e worker slot ${e2eWorkerSlot} of ${e2eWorkers}`,
  });
});

const overrideStackPortsEffect = (projectDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const configPath = pathService.join(projectDir, "supabase", "config.toml");
    /* Decoded keeping a leading byte order mark, like Node's `Buffer#toString`. */
    const config = chunkDecoder.decode(yield* fs.readFile(configPath));
    const assigned = new Set<number>();
    const lines: string[] = [];
    for (const line of config.split("\n")) {
      const match = /^(\s*(?:port|smtp_port|pop3_port|inspector_port|shadow_port) = )\d+$/.exec(
        line,
      );
      if (match === null) {
        lines.push(line);
        continue;
      }
      let port = yield* pickFreePort;
      while (assigned.has(port)) {
        port = yield* pickFreePort;
      }
      assigned.add(port);
      lines.push(`${match[1]}${port}`);
    }
    yield* fs.writeFileString(configPath, lines.join("\n"));
  });

/**
 * Rewrites every active port assignment in an `init`-generated
 * `supabase/config.toml` with a freshly allocated free port, so stacks started
 * from default configs cannot collide on host ports with other e2e stacks on
 * the same runner. Commented-out port lines are left untouched.
 */
export function overrideStackPorts(projectDir: string): Promise<void> {
  return runHelper(overrideStackPortsEffect(projectDir));
}

const makeTempProjectEffect = (prefix = "supabase-project-e2e-") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const context = yield* Effect.context<FileSystem.FileSystem>();
    const projectDir = yield* fs.makeTempDirectory({ prefix });

    return {
      dir: projectDir,
      cleanup: (): Promise<void> =>
        Effect.runPromiseWith(context)(
          removeOwnedDir(projectDir).pipe(Effect.mapError(helperRejection)),
        ),
    };
  });

const makeTempCliProjectEffect = (prefix = "supabase-cli-e2e-") =>
  makeTempProjectEffect(prefix).pipe(
    Effect.tap((project) => Effect.sync(() => registerTempStackProject(project))),
  );

/** Create an isolated CLI project without pre-allocating released ports. */
export function makeTempCliProject(prefix?: string) {
  return runHelper(makeTempCliProjectEffect(prefix));
}

const stopAndRemoveStackProject = (dir: string, cleanupTimeoutMs: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    if (!(yield* pathExists(fs, dir))) return;

    // `init` can fail before creating a project config. There is no stack to
    // stop in that case, so remove the exact owned directory directly.
    if (!(yield* pathExists(fs, pathService.join(dir, "supabase", "config.toml")))) {
      yield* removeOwnedDir(dir);
      return;
    }

    const stopped = yield* runSupabaseEffect(["stop", "--no-backup"], {
      cwd: dir,
      exitTimeoutMs: cleanupTimeoutMs,
    });
    if (stopped.exitCode !== 0) {
      return yield* new TempStackCleanupError({
        message: [
          `Failed to stop stack in ${dir} (exit code ${stopped.exitCode}).`,
          `stdout:\n${stopped.stdout}`,
          `stderr:\n${stopped.stderr}`,
        ].join("\n"),
      });
    }

    yield* removeOwnedDir(dir);
  });

const makeTempCliStackProjectEffect = (prefix: string, cleanupTimeoutMs: number) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    const project = yield* makeTempProjectEffect(prefix);
    const stackProject = {
      dir: project.dir,
      cleanup: (): Promise<void> =>
        Effect.runPromiseWith(context)(
          stopAndRemoveStackProject(project.dir, cleanupTimeoutMs).pipe(
            Effect.mapError(helperRejection),
          ),
        ),
    };
    yield* Effect.sync(() => registerTempStackProject(stackProject));
    return stackProject;
  });

export function makeTempCliStackProject(
  prefix = "supabase-stack-e2e-",
  cleanupTimeoutMs = DEFAULT_STACK_CLEANUP_TIMEOUT_MS,
) {
  return runHelper(makeTempCliStackProjectEffect(prefix, cleanupTimeoutMs));
}

/** Concurrent e2e files each run a stack, and Docker names its containers after the project id. */
const projectIdFor = (pathService: Path.Path, dir: string) =>
  `e2e-${pathService
    .basename(dir)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(-8)}`;

const makeTempStackProjectEffect = (prefix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const project = yield* makeTempProjectEffect(prefix);
    const ports = {
      apiPort: yield* pickFreePort,
      dbPort: yield* pickFreePort,
      authPort: yield* pickFreePort,
      postgrestPort: yield* pickFreePort,
      postgrestAdminPort: yield* pickFreePort,
      edgeRuntimePort: yield* pickFreePort,
      edgeRuntimeInspectorPort: yield* pickFreePort,
      realtimePort: yield* pickFreePort,
      storagePort: yield* pickFreePort,
      imgproxyPort: yield* pickFreePort,
      mailpitPort: yield* pickFreePort,
      mailpitSmtpPort: yield* pickFreePort,
      mailpitPop3Port: yield* pickFreePort,
      pgmetaPort: yield* pickFreePort,
      studioPort: yield* pickFreePort,
      analyticsPort: yield* pickFreePort,
      poolerPort: yield* pickFreePort,
      poolerApiPort: yield* pickFreePort,
    };

    const supabaseDir = pathService.join(project.dir, "supabase");
    yield* fs.makeDirectory(supabaseDir, { recursive: true });
    yield* fs.writeFileString(
      pathService.join(supabaseDir, "config.toml"),
      [
        `project_id = "${projectIdFor(pathService, project.dir)}"`,
        "",
        "[api]",
        `port = ${ports.apiPort}`,
        "",
        "[db]",
        `port = ${ports.dbPort}`,
        "",
        "[db.pooler]",
        `port = ${ports.poolerPort}`,
        "",
        "[edge_runtime]",
        `inspector_port = ${ports.edgeRuntimeInspectorPort}`,
        "",
        "[local_smtp]",
        `port = ${ports.mailpitPort}`,
        `smtp_port = ${ports.mailpitSmtpPort}`,
        `pop3_port = ${ports.mailpitPop3Port}`,
        "",
        "[studio]",
        `port = ${ports.studioPort}`,
        "",
        "[analytics]",
        `port = ${ports.analyticsPort}`,
        "",
      ].join("\n"),
    );

    const stackProject = {
      ...project,
      ports,
    };
    yield* Effect.sync(() => registerTempStackProject(stackProject));
    return stackProject;
  });

export function makeTempStackProject(prefix = "supabase-stack-e2e-") {
  return runHelper(makeTempStackProjectEffect(prefix));
}

/** Send a signal to the process group led by `pid`. */
function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {}
}

/** Send a signal to the process `pid` alone. */
function killProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {}
}

function outputTail(label: string, output: string): string {
  if (output.length === 0) {
    return `${label}: <empty>`;
  }

  const tail =
    output.length > OUTPUT_TAIL_LENGTH ? output.slice(output.length - OUTPUT_TAIL_LENGTH) : output;
  return `${label}:\n${tail}`;
}

export interface SpawnSupabaseOptions {
  readonly cwd?: string;
  /** `undefined` REMOVES the key from the child env (base env and pins included). */
  readonly env?: Record<string, string | undefined>;
  /** Reuse a temp SUPABASE_HOME directory instead of creating a new one per call. */
  readonly home?: string;
  /** Write this string to stdin, then close it. */
  readonly stdin?: string;
  /** Whether to kill the whole process group once the root process exits. */
  readonly cleanupProcessGroupOnClose?: boolean;
  /** Maximum time to wait for the process to exit before force-killing it. */
  readonly exitTimeoutMs?: number;
  /** Close the read end of stdout at spawn, like a `| head` reader that has already exited. */
  readonly closeStdout?: boolean;
}

export interface SpawnedSupabase {
  readonly pid: number;
  readonly homeDir: string;
  readonly stdout: () => string;
  readonly stderr: () => string;
  /** Signals the process group, then the root process while it still runs. */
  readonly kill: (signal?: NodeJS.Signals) => Effect.Effect<void>;
  readonly waitForOutput: (
    pattern: RegExp,
    timeoutMs?: number,
    startAt?: number,
  ) => Effect.Effect<void, CliOutputWaitError>;
  /**
   * The single exit path: waits for exit and drained output within the exit bound (SIGKILLing
   * the group when it fires), kills the group, disposes the owned home, and surfaces a deferred
   * stdin write failure.
   */
  readonly waitForExit: (
    timeoutMs?: number,
  ) => Effect.Effect<RunResult, CliHomeDisposeError | CliStdinWriteError>;
}

const isBrokenPipe = (error: { readonly cause?: unknown }) =>
  Predicate.hasProperty(error.cause, "code") && error.cause.code === "EPIPE";

/*
 * The Effect spawner only hands out stdout as a stream it reads itself, so a pipe whose reader
 * has exited needs a relay: it runs the CLI on a real pipe, closes the read end at once, and
 * mirrors the CLI's exit code. It ignores group signals so the CLI's own exit wins.
 */
const closedStdoutRelay = (argvJson: string) =>
  [
    `const { spawn } = require("node:child_process");`,
    `const child = spawn(process.execPath, ${argvJson}, { stdio: ["inherit", "pipe", "inherit"] });`,
    `child.stdout.destroy();`,
    `for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => {});`,
    `child.on("exit", (code) => process.exit(code ?? 1));`,
  ].join("\n");

const encodeArgv = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

const spawnSupabaseProgram = Effect.fnUntraced(function* (
  args: ReadonlyArray<string>,
  options: SpawnSupabaseOptions | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  let disposedOwnHome = false;
  const disposeHome = (home: TempHome) =>
    Effect.suspend(() => {
      if (disposedOwnHome) {
        return Effect.void;
      }
      disposedOwnHome = true;
      return home.dispose;
    });
  /* The run-owned home's removal is registered with its creation, so cancellation never leaks it;
     as the first release it runs last, after the child is killed. */
  const ownHome = options?.home
    ? undefined
    : yield* Effect.acquireRelease(
        createTempHomeEffect.pipe(
          Effect.mapError((cause) => new CliSpawnError({ cause: hostCause(cause) })),
        ),
        (home) => Effect.orDie(disposeHome(home)),
      );
  const homeDir = options?.home ?? ownHome?.dir ?? "";
  yield* Effect.sync(() => noteStackCliProjectHome(options?.cwd, homeDir));
  const usesStartWrapper = args[0] === "start";
  // An `undefined` in `options.env` removes the key entirely — pins and ambient values alike —
  // so a cache-subject test can run with a variable genuinely absent (the shipped default),
  // not just overridden.
  const mergedEnv: Record<string, string | undefined> = {
    ...subprocessBaseEnv(),
    SUPABASE_HOME: homeDir,
    SUPABASE_NO_KEYRING: "1",
    SUPABASE_TELEMETRY_DISABLED: "1",
    // Isolate e2e from the default-ON shadow cache. Cache-subject tests opt back in (or unset
    // the key with `undefined`) via `options.env`.
    SUPABASE_SHADOW_CACHE: "0",
    ...options?.env,
  };
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(mergedEnv)) {
    if (value !== undefined) env[key] = value;
  }
  const artifactsExist = (yield* pathExists(fs, SHIM_PATH)) && (yield* pathExists(fs, BINARY_PATH));
  if (!artifactsExist) {
    return yield* new CliBuildArtifactsError({
      message:
        `Missing CLI build artifacts. Run \`pnpm --filter supabase build\` before invoking e2e tests.\n` +
        `  expected shim:   ${SHIM_PATH}\n` +
        `  expected binary: ${BINARY_PATH}`,
    });
  }
  // Exercise the same shim + compiled shell binary handoff that published
  // packages use. `SUPABASE_CLI_BINARY_OVERRIDE` points the shim at the local
  // build artifact without needing platform wrapper packages.
  env["SUPABASE_CLI_BINARY_OVERRIDE"] = BINARY_PATH;
  const shimArgs = [SHIM_PATH, ...args];
  const commandArgs = options?.closeStdout
    ? ["-e", closedStdoutRelay(yield* encodeArgv(shimArgs))]
    : shimArgs;
  const handle = yield* spawner.spawn(
    ChildProcess.make("node", commandArgs, {
      cwd: options?.cwd,
      env,
      extendEnv: false,
      stdin: usesStartWrapper || options?.stdin !== undefined ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      // Own process group so tests can distinguish product cleanup from helper cleanup.
      detached: true,
      /* The harness owns every group kill. The spawner signals the group itself on a nonzero exit
         and at release; SIGURG is ignored by default and leaves stopped processes stopped. */
      killSignal: "SIGURG",
    }),
  );
  const pid = handle.pid;

  let stdout = "";
  let stderr = "";
  let closeResult: RunResult | undefined;
  let cleanedUpProcessGroup = false;
  let stdinError: unknown;
  const closed = yield* Deferred.make<RunResult>();
  const stdoutChanged = yield* PubSub.unbounded<void>();

  const cleanupProcessGroupOnClose = Effect.sync(() => {
    if (cleanedUpProcessGroup || !(options?.cleanupProcessGroupOnClose ?? true)) {
      return;
    }
    cleanedUpProcessGroup = true;
    killProcessGroup(pid, "SIGKILL");
  });

  const disposeOwnHome = ownHome === undefined ? Effect.void : disposeHome(ownHome);

  const signal = (name: NodeJS.Signals) =>
    Effect.flatMap(
      Effect.orElseSucceed(handle.isRunning, () => false),
      (running) =>
        Effect.sync(() => {
          killProcessGroup(pid, name);
          if (running) killProcess(pid, name);
        }),
    );

  /* Each chunk is decoded on its own and keeps a byte order mark, like `Buffer#toString`. */
  const drain = (
    stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
    append: (chunk: string) => Effect.Effect<void>,
  ) => Stream.runForEach(stream, (chunk) => append(chunkDecoder.decode(chunk))).pipe(Effect.ignore);

  const stdoutDrained = yield* Effect.forkScoped(
    drain(handle.stdout, (chunk) =>
      Effect.sync(() => {
        stdout += chunk;
      }).pipe(Effect.andThen(PubSub.publish(stdoutChanged, undefined))),
    ),
  );
  const stderrDrained = yield* Effect.forkScoped(
    drain(handle.stderr, (chunk) =>
      Effect.sync(() => {
        stderr += chunk;
      }),
    ),
  );
  /* "close" in Node terms: the root exited and every holder of its stdout/stderr let go. */
  yield* Effect.forkScoped(
    Effect.gen(function* () {
      const [exitCode] = yield* Effect.all(
        [
          /* A signal death has no code and reports exit code 1. */
          handle.exitCode.pipe(
            Effect.map((code): number => code),
            Effect.orElseSucceed(() => 1),
          ),
          Fiber.join(stdoutDrained),
          Fiber.join(stderrDrained),
        ],
        { concurrency: "unbounded" },
      );
      const result: RunResult = { stdout, stderr, exitCode };
      closeResult = result;
      yield* PubSub.publish(stdoutChanged, undefined);
      yield* Deferred.succeed(closed, result);
    }),
  );

  if (options?.stdin !== undefined) {
    yield* Effect.forkScoped(
      Stream.run(Stream.make(new TextEncoder().encode(options.stdin)), handle.stdin).pipe(
        Effect.catchTag("PlatformError", (error) =>
          Effect.sync(() => {
            if (!isBrokenPipe(error)) stdinError = hostCause(error);
          }),
        ),
      ),
    );
  }

  // Scope release owns the spawned group: a run that did not complete always kills it so the
  // child is never orphaned, without re-signaling a group the close path already cleaned. On
  // successful completion the caller's `cleanupProcessGroupOnClose: false` opt-out is honoured.
  yield* Effect.addFinalizer((exit) =>
    Effect.gen(function* () {
      const successOptOut = Exit.isSuccess(exit) && options?.cleanupProcessGroupOnClose === false;
      // `closeResult === undefined` is the honest liveness test: the pid is still owned,
      // so signaling is safe and necessary; once the child has closed, signaling again
      // would only race pid reuse.
      if (successOptOut) {
        yield* Effect.ignore(handle.unref);
      } else if (closeResult === undefined) {
        cleanedUpProcessGroup = true;
        yield* signal("SIGKILL");
      }
    }),
  );

  const stdinFailure = (result: RunResult) =>
    new Error(
      [
        `stdin write to the CLI failed`,
        `Command: supabase ${args.join(" ")}`,
        `PID: ${pid}`,
        `exit code: ${result.exitCode}${
          result.timedOutAfterMs === undefined
            ? ""
            : ` (no exit within ${result.timedOutAfterMs}ms, SIGKILLed by the harness)`
        }`,
        outputTail("stdout tail", result.stdout),
        outputTail("stderr tail", result.stderr),
      ].join("\n\n"),
      { cause: stdinError },
    );

  const waitForExit = (
    timeoutMs = options?.exitTimeoutMs ?? DEFAULT_EXIT_TIMEOUT_MS,
  ): Effect.Effect<RunResult, CliHomeDisposeError | CliStdinWriteError> =>
    Deferred.await(closed).pipe(
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () =>
          signal("SIGKILL").pipe(
            Effect.andThen(Deferred.await(closed)),
            Effect.map((result): RunResult => ({ ...result, timedOutAfterMs: timeoutMs })),
          ),
      }),
      Effect.tap(() => cleanupProcessGroupOnClose),
      Effect.onInterrupt(() =>
        cleanupProcessGroupOnClose.pipe(
          // The home may still be in use when the opt-out kept the child alive here; in
          // that case the scope release disposes it.
          Effect.andThen(
            Effect.suspend(() =>
              closeResult !== undefined || cleanedUpProcessGroup
                ? Effect.orDie(disposeOwnHome)
                : Effect.void,
            ),
          ),
        ),
      ),
      Effect.tap(() => disposeOwnHome),
      Effect.flatMap((result) =>
        stdinError === undefined
          ? Effect.succeed(result)
          : Effect.fail(new CliStdinWriteError({ cause: stdinFailure(result) })),
      ),
    );

  const outputWaitError = (reason: string, pattern: RegExp) =>
    new CliOutputWaitError({
      message: [
        `${reason} ${pattern}`,
        `Command: supabase ${args.join(" ")}`,
        `PID: ${pid}`,
        outputTail("stdout tail", stdout),
        outputTail("stderr tail", stderr),
      ].join("\n\n"),
    });

  const outputMatches = (pattern: RegExp, startAt: number) => {
    pattern.lastIndex = 0;
    return pattern.test(stdout.slice(startAt));
  };

  const waitForOutput = (
    pattern: RegExp,
    timeoutMs = 60_000,
    startAt = 0,
  ): Effect.Effect<void, CliOutputWaitError> =>
    Effect.scoped(
      Effect.gen(function* () {
        /* Subscribe before the first check so no chunk lands between the check and the wait. */
        const changes = yield* PubSub.subscribe(stdoutChanged);
        while (!outputMatches(pattern, startAt)) {
          if (closeResult !== undefined) {
            return yield* outputWaitError("Process exited before output matched", pattern);
          }
          yield* PubSub.take(changes);
        }
      }),
    ).pipe(
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () =>
          Effect.fail(outputWaitError("Timed out waiting for output matching", pattern)),
      }),
    );

  const spawned: SpawnedSupabase = {
    pid,
    homeDir,
    stdout: () => stdout,
    stderr: () => stderr,
    kill: (name = "SIGTERM") => signal(name),
    waitForOutput,
    waitForExit,
  };
  return spawned;
});

/**
 * Spawns the compiled CLI in its own process group, owned by the calling scope: closing the
 * scope kills a run that has not closed (unless `cleanupProcessGroupOnClose: false` and the
 * scope succeeded) and disposes the run-owned temp home.
 */
export const spawnSupabase = (
  args: ReadonlyArray<string>,
  options?: SpawnSupabaseOptions,
): Effect.Effect<SpawnedSupabase, CliSpawnError, Scope.Scope> =>
  spawnSupabaseProgram(args, options).pipe(
    Effect.catchTags({
      PlatformError: (cause) => Effect.fail(new CliSpawnError({ cause: hostCause(cause) })),
      CliBuildArtifactsError: (cause) =>
        Effect.fail(new CliSpawnError({ cause: hostOrPlainError(cause) })),
      SchemaError: (cause) => Effect.fail(new CliSpawnError({ cause })),
    }),
    Effect.provide(helperServices),
  );

/**
 * Effect-native CLI run. The spawned process group is owned by the run's scope, so an
 * interrupted test kills the child instead of orphaning it; `cleanupProcessGroupOnClose:
 * false` is honoured only on successful completion. `runSupabase` is the Promise facade
 * over the same exit path.
 */
export const runSupabaseEffect = (
  args: string[],
  options?: SpawnSupabaseOptions,
): Effect.Effect<RunResult, CliRunError> =>
  Effect.scoped(Effect.flatMap(spawnSupabase(args, options), (spawned) => spawned.waitForExit()));

/** Kills the run once stdout matches `until`; the harness then reports exit code 0. */
const runSupabaseUntil = (
  args: string[],
  until: RegExp,
  options: SpawnSupabaseOptions & { readonly untilTimeoutMs?: number },
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawned = yield* spawnSupabase(args, options);
      yield* spawned.waitForOutput(until, options.untilTimeoutMs);
      yield* spawned.kill("SIGTERM");
      yield* Effect.forkChild(
        Effect.sleep(15_000).pipe(
          Effect.andThen(Effect.sync(() => killProcessGroup(spawned.pid, "SIGKILL"))),
        ),
      );
      const result = yield* spawned.waitForExit();
      return { ...result, exitCode: 0 };
    }),
  );

export function runSupabase(
  args: string[],
  options?: {
    cwd?: string;
    /** `undefined` REMOVES the key from the child env (base env and pins included). */
    env?: Record<string, string | undefined>;
    /** Reuse a temp SUPABASE_HOME directory instead of creating a new one per call. */
    home?: string;
    /** Write this string to stdin, then close it. */
    stdin?: string;
    /** Kill the process as soon as stdout matches this pattern. */
    until?: RegExp;
    /** How long to wait for the `until` pattern before failing. */
    untilTimeoutMs?: number;
    /** Maximum time to wait for the command to exit before force-killing it. */
    exitTimeoutMs?: number;
  },
): Promise<RunResult> {
  return Effect.runPromise(
    Effect.mapError(
      options?.until === undefined
        ? runSupabaseEffect(args, options)
        : runSupabaseUntil(args, options.until, options),
      helperRejection,
    ),
  );
}

export function requireCliSuccess(
  result: {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly timedOutAfterMs?: number;
  },
  command: string,
): void {
  if (result.exitCode !== 0) {
    const reason =
      result.timedOutAfterMs === undefined
        ? `exit ${result.exitCode}`
        : `exit ${result.exitCode}; harness SIGKILLed it after ${result.timedOutAfterMs}ms without exit`;
    throw new Error(
      `${command} failed (${reason})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}

class DockerCommandError extends Data.TaggedError("DockerCommandError")<{
  readonly message: string;
  readonly stdout: string;
  readonly stderr: string;
}> {}

/** Owns a Docker CLI process and drains its output while it runs. */
export const runDockerEffect = (
  args: ReadonlyArray<string>,
  options: { readonly timeout?: number; readonly forceKillAfter?: number } = {},
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make("docker", args, {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        forceKillAfter: options.forceKillAfter,
      }),
    );
    // Keep recent diagnostics while draining both pipes completely so the child can exit.
    const captureTail = <E, R>(stream: Stream.Stream<Uint8Array, E, R>) =>
      Stream.runFold(
        Stream.decodeText(stream),
        () => ({ text: "", truncated: false }),
        (state, chunk) => {
          const tail = (state.text + chunk.slice(-65_536)).slice(-65_536);
          const first = tail.charCodeAt(0);
          return {
            // A UTF-16 bound can cut a surrogate pair; discard its orphaned low half.
            text: first >= 0xdc00 && first <= 0xdfff ? tail.slice(1) : tail,
            truncated: state.truncated || state.text.length + chunk.length > 65_536,
          };
        },
      ).pipe(
        Effect.map(({ text, truncated }) =>
          truncated ? `[output truncated; showing at most 65536 UTF-16 code units]\n${text}` : text,
        ),
      );
    const [exitCode, stdout, stderr] = yield* Effect.all(
      [child.exitCode, captureTail(child.stdout), captureTail(child.stderr)],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0) {
      return yield* new DockerCommandError({
        message: `docker ${args.join(" ")} exited ${exitCode}: ${stderr}`,
        stdout,
        stderr,
      });
    }
    return { stdout, stderr };
  }).pipe(
    (effect) =>
      options.timeout === undefined
        ? effect
        : Effect.timeoutOrElse(effect, {
            duration: options.timeout,
            orElse: () =>
              new DockerCommandError({
                message: `docker ${args.join(" ")} timed out after ${options.timeout}ms`,
                stdout: "",
                stderr: "",
              }),
          }),
    Effect.scoped,
  );
