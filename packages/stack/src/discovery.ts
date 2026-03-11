import { Data, Duration, Effect } from "effect";
import { FileSystem, Path } from "effect";
import { NoRunningStackError, StateManager } from "./StateManager.ts";
import { resolveManagedStack } from "./managed-stack.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StackSummary {
  readonly name: string;
  readonly pid: number;
  readonly alive: boolean;
  readonly url: string;
  readonly dbUrl: string;
  readonly startedAt: string;
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
 * Reads state files from the stacks directory and checks each PID.
 */
export const listStacks = (opts: {
  home: string;
}): Effect.Effect<ReadonlyArray<StackSummary>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const { home } = opts;
    const stateManager = yield* StateManager.asEffect().pipe(
      Effect.provide(StateManager.make(home)),
    );
    const states = yield* stateManager.scan();

    const summaries: StackSummary[] = [];
    for (const state of states) {
      const alive = yield* stateManager.isAlive(state);
      summaries.push({
        name: state.name,
        pid: state.pid,
        alive,
        url: state.url,
        dbUrl: state.dbUrl,
        startedAt: state.startedAt,
      });
    }
    return summaries;
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
  home: string;
}): Effect.Effect<
  void,
  NoRunningStackError | DaemonStillRunningError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const { home } = opts;
    const stateManager = yield* StateManager.asEffect().pipe(
      Effect.provide(StateManager.make(home)),
    );
    const { state, alive } = yield* resolveManagedStack(opts);
    if (!alive) {
      return;
    }

    // Send stop request to daemon's Unix socket
    yield* Effect.tryPromise({
      try: () =>
        fetch("http://localhost/stop", {
          method: "POST",
          unix: state.socketPath,
        } as RequestInit),
      catch: () => {
        // Connection refused means daemon already exited — not an error
      },
    }).pipe(Effect.ignore);

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
