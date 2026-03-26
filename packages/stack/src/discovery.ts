import { Data, Duration, Effect } from "effect";
import { FileSystem, Path } from "effect";
import { defaultManagedStackName } from "./createStack.ts";
import {
  InvalidStackMetadataError,
  InvalidStackStateError,
  NoRunningStackError,
  StateManager,
  scanAllManagedMetadata,
  projectStateManagerPathsFromRoot,
  projectStateManagerPaths,
  scanAllManagedStates,
  UnsupportedStackMetadataVersionError,
} from "./StateManager.ts";
import type { StackMetadata } from "./StackMetadata.ts";
import { UnixHttpClient } from "./UnixHttpClient.ts";
import { resolveManagedStack } from "./managed-stack.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StackSummary {
  readonly name: string;
  readonly running: boolean;
  readonly ports: StackMetadata["ports"];
  readonly versions: StackMetadata["services"];
  readonly pid?: number;
  readonly url?: string;
  readonly dbUrl?: string;
  readonly startedAt?: string;
}

export class DaemonStillRunningError extends Data.TaggedError("DaemonStillRunningError")<{
  readonly name: string;
  readonly pid: number;
}> {}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * List all known stacks and their liveness status.
 * Reads durable stack metadata and overlays live daemon state when present.
 */
export const listStacks = (opts: {
  cacheRoot: string;
  projectStateRoot?: string;
}): Effect.Effect<
  ReadonlyArray<StackSummary>,
  InvalidStackMetadataError | InvalidStackStateError | UnsupportedStackMetadataVersionError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const metadataEntries =
      opts.projectStateRoot === undefined
        ? yield* scanAllManagedMetadata(opts.cacheRoot)
        : yield* StateManager.asEffect().pipe(
            Effect.provide(
              StateManager.make(projectStateManagerPathsFromRoot(opts.projectStateRoot)),
            ),
            Effect.flatMap((stateManager) => stateManager.scanMetadata()),
            Effect.map((metadata) =>
              Array.from(metadata.entries()).map(([name, stackMetadata]) => ({
                name,
                metadata: stackMetadata,
              })),
            ),
          );
    const states =
      opts.projectStateRoot === undefined
        ? yield* scanAllManagedStates(opts.cacheRoot)
        : yield* StateManager.asEffect().pipe(
            Effect.provide(
              StateManager.make(projectStateManagerPathsFromRoot(opts.projectStateRoot)),
            ),
            Effect.flatMap((stateManager) => stateManager.scan()),
          );

    const statesByName = new Map(states.map((state) => [state.name, state] as const));
    const summaries: StackSummary[] = [];

    for (const { name, metadata } of metadataEntries) {
      const state = statesByName.get(name);
      if (state === undefined) {
        summaries.push({
          name,
          running: false,
          ports: metadata.ports,
          versions: metadata.services,
        });
        continue;
      }

      const stateManager = yield* StateManager.asEffect().pipe(
        Effect.provide(
          StateManager.make(
            opts.projectStateRoot === undefined
              ? projectStateManagerPaths(opts.cacheRoot, state.projectDir)
              : projectStateManagerPathsFromRoot(opts.projectStateRoot),
          ),
        ),
      );
      const alive = yield* stateManager.isAlive(state);
      if (!alive) {
        summaries.push({
          name,
          running: false,
          ports: metadata.ports,
          versions: metadata.services,
        });
        continue;
      }

      summaries.push({
        name: state.name,
        running: true,
        ports: metadata.ports,
        versions: metadata.services,
        pid: state.pid,
        url: state.url,
        dbUrl: state.dbUrl,
        startedAt: state.startedAt,
      });
    }

    return summaries.sort((left, right) => left.name.localeCompare(right.name));
  });

export const resolveStackSummary = (opts: {
  cacheRoot: string;
  projectStateRoot?: string;
  name: string;
}): Effect.Effect<
  StackSummary,
  | NoRunningStackError
  | InvalidStackMetadataError
  | InvalidStackStateError
  | UnsupportedStackMetadataVersionError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const summaries = yield* listStacks(opts);
    const summary = summaries.find((candidate) => candidate.name === opts.name);
    if (summary !== undefined) {
      return summary;
    }
    return yield* new NoRunningStackError({ cwd: opts.projectStateRoot ?? process.cwd() });
  });

/**
 * Stop a running daemon by name or working directory.
 * Sends POST /stop to the daemon's Unix socket and waits for it to exit.
 * The daemon owns its own state cleanup; this function only removes stale
 * state after confirming the process is no longer alive.
 */
export const stopDaemon = (opts: {
  name?: string;
  cwd?: string;
  cacheRoot: string;
  projectDir?: string;
  projectStateRoot?: string;
}): Effect.Effect<
  void,
  NoRunningStackError | InvalidStackStateError | DaemonStillRunningError,
  FileSystem.FileSystem | Path.Path | UnixHttpClient
> =>
  Effect.gen(function* () {
    const { state, alive } = yield* resolveManagedStack(opts);
    const stateManager = yield* StateManager.asEffect().pipe(
      Effect.provide(
        StateManager.make(
          opts.projectStateRoot === undefined
            ? projectStateManagerPaths(opts.cacheRoot, state.projectDir)
            : projectStateManagerPathsFromRoot(opts.projectStateRoot),
        ),
      ),
    );
    if (!alive) {
      return;
    }

    // Send stop request to daemon's Unix socket
    const unixHttpClient = yield* UnixHttpClient;
    yield* unixHttpClient
      .request(state.socketPath, "/stop", { method: "POST" })
      .pipe(Effect.ignore);

    const stopped = yield* Effect.gen(function* () {
      const maxWait = 30_000;
      const start = Date.now();
      while (Date.now() - start < maxWait) {
        const stillAlive = yield* stateManager.isAlive(state);
        if (!stillAlive) return true;
        yield* Effect.sleep(Duration.millis(200));
      }
      return false;
    });

    if (!stopped) {
      return yield* new DaemonStillRunningError({ name: state.name, pid: state.pid });
    }

    // Clean up any state the daemon did not remove for itself.
    yield* stateManager.remove(state.name);
  });

export const deleteManagedStackPersistence = (opts: {
  name?: string;
  cwd?: string;
  cacheRoot: string;
  projectDir?: string;
  projectStateRoot?: string;
}): Effect.Effect<void, NoRunningStackError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const cwd = opts.cwd ?? process.cwd();
    const projectDir = opts.projectDir ?? cwd;
    const stateManager = yield* StateManager.asEffect().pipe(
      Effect.provide(
        StateManager.make(
          opts.projectStateRoot === undefined
            ? projectStateManagerPaths(opts.cacheRoot, projectDir)
            : projectStateManagerPathsFromRoot(opts.projectStateRoot),
        ),
      ),
    );
    const name = opts.name ?? defaultManagedStackName(projectDir);
    const exists = yield* stateManager.stackExists(name);
    if (!exists) {
      return yield* new NoRunningStackError({ cwd });
    }

    yield* stateManager.deleteStack(name);
  });
