import { Effect } from "effect";
import { FileSystem, Path } from "effect";
import {
  InvalidStackStateError,
  NoRunningStackError,
  StateManager,
  projectStateManagerPathsFromRoot,
  projectStateManagerPaths,
  scanAllManagedStates,
  type StackState,
} from "./StateManager.ts";

export interface ManagedStack {
  readonly state: StackState;
  readonly alive: boolean;
}

export const resolveManagedStack = (opts: {
  readonly cacheRoot: string;
  readonly name?: string;
  readonly cwd?: string;
  readonly projectDir?: string;
  readonly projectStateRoot?: string;
}): Effect.Effect<
  ManagedStack,
  NoRunningStackError | InvalidStackStateError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const cwd = opts.cwd ?? process.cwd();
    const path = yield* Path.Path;
    const allStates =
      opts.projectStateRoot === undefined
        ? yield* scanAllManagedStates(opts.cacheRoot)
        : yield* StateManager.pipe(
            Effect.provide(
              StateManager.make(projectStateManagerPathsFromRoot(opts.projectStateRoot)),
            ),
            Effect.flatMap((stateManager) => stateManager.scan()),
          );

    const projectDir =
      opts.projectDir ??
      (() => {
        const byDir = new Map<string, StackState>();
        for (const state of allStates) {
          byDir.set(state.projectDir, state);
        }

        let current = path.resolve(cwd);
        const root = path.parse(current).root;
        while (true) {
          const match = byDir.get(current);
          if (match !== undefined) {
            return match.projectDir;
          }
          if (current === root) {
            return undefined;
          }
          current = path.dirname(current);
        }
      })();

    const matchingStates =
      projectDir === undefined
        ? allStates
        : allStates.filter((state) => state.projectDir === projectDir);

    const state =
      opts.name === undefined
        ? matchingStates[0]
        : matchingStates.find((candidate) => candidate.name === opts.name);

    if (state === undefined) {
      return yield* new NoRunningStackError({ cwd });
    }

    const stateManager = yield* StateManager.pipe(
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
      yield* stateManager.remove(state.name);
    }

    return {
      state,
      alive,
    };
  });
