import { Effect } from "effect";
import { FileSystem, Path } from "effect";
import { NoRunningStackError, StateManager, type StackState } from "./StateManager.ts";

export interface ManagedStack {
  readonly state: StackState;
  readonly alive: boolean;
}

export const resolveManagedStack = (opts: {
  readonly home: string;
  readonly name?: string;
  readonly cwd?: string;
}): Effect.Effect<ManagedStack, NoRunningStackError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const { home } = opts;
    const stateManager = yield* StateManager.asEffect().pipe(
      Effect.provide(StateManager.make(home)),
    );

    const cwd = opts.cwd ?? process.cwd();
    const state = opts.name
      ? yield* stateManager
          .read(opts.name)
          .pipe(Effect.mapError(() => new NoRunningStackError({ cwd })))
      : yield* stateManager.resolve(cwd);

    const alive = yield* stateManager.isAlive(state);
    if (!alive) {
      yield* stateManager.remove(state.name);
    }

    return {
      state,
      alive,
    };
  });
