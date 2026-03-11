import { Data, Effect, Layer, ServiceMap } from "effect";
import { FileSystem, Path } from "effect";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StackState {
  readonly pid: number;
  readonly name: string;
  readonly projectDir: string;
  readonly apiPort: number;
  readonly dbPort: number;
  readonly socketPath: string;
  readonly startedAt: string;
  readonly url: string;
  readonly dbUrl: string;
  readonly publishableKey: string;
  readonly secretKey: string;
  readonly anonJwt: string;
  readonly serviceRoleJwt: string;
  readonly dockerContainerNames: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class StateNotFoundError extends Data.TaggedError("StateNotFoundError")<{
  readonly name: string;
}> {}

export class NoRunningStackError extends Data.TaggedError("NoRunningStackError")<{
  readonly cwd: string;
}> {}

export class StackAlreadyRunningError extends Data.TaggedError("StackAlreadyRunningError")<{
  readonly name: string;
  readonly pid: number;
  readonly message: string;
}> {}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class StateManager extends ServiceMap.Service<
  StateManager,
  {
    readonly stackDir: (name: string) => string;
    readonly socketPath: (name: string) => string;
    readonly write: (state: StackState) => Effect.Effect<void>;
    readonly read: (name: string) => Effect.Effect<StackState, StateNotFoundError>;
    readonly scan: () => Effect.Effect<ReadonlyArray<StackState>>;
    readonly remove: (name: string) => Effect.Effect<void>;
    readonly resolve: (cwd: string) => Effect.Effect<StackState, NoRunningStackError>;
    readonly isAlive: (state: StackState) => Effect.Effect<boolean>;
  }
>()("stack/StateManager") {
  static make(home: string): Layer.Layer<StateManager, never, FileSystem.FileSystem | Path.Path> {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stacksRoot = path.join(home, "stacks");

        const stackDir = (name: string) => path.join(stacksRoot, name);
        const socketPath = (name: string) => path.join(stacksRoot, name, "daemon.sock");
        const stateFile = (name: string) => path.join(stacksRoot, name, "state.json");

        const write = (state: StackState): Effect.Effect<void> =>
          Effect.gen(function* () {
            const dir = stackDir(state.name);
            yield* fs.makeDirectory(dir, { recursive: true });
            yield* fs.writeFileString(stateFile(state.name), JSON.stringify(state, null, 2));
          }).pipe(Effect.catchTag("PlatformError", (e) => Effect.die(e)));

        const read = (name: string): Effect.Effect<StackState, StateNotFoundError> =>
          Effect.gen(function* () {
            const filePath = stateFile(name);
            const exists = yield* fs.exists(filePath);
            if (!exists) return yield* new StateNotFoundError({ name });
            const content = yield* fs.readFileString(filePath);
            return JSON.parse(content) as StackState;
          }).pipe(Effect.catchTag("PlatformError", (e) => Effect.die(e)));

        const scan = (): Effect.Effect<ReadonlyArray<StackState>> =>
          Effect.gen(function* () {
            const exists = yield* fs.exists(stacksRoot);
            if (!exists) return [] as ReadonlyArray<StackState>;

            const entries = yield* fs.readDirectory(stacksRoot);
            const states: StackState[] = [];

            for (const entry of entries) {
              const filePath = stateFile(entry);
              const fileExists = yield* fs.exists(filePath);
              if (!fileExists) continue;

              try {
                const content = yield* fs.readFileString(filePath);
                states.push(JSON.parse(content) as StackState);
              } catch {
                // Skip malformed state files
              }
            }
            return states;
          }).pipe(Effect.catchTag("PlatformError", (e) => Effect.die(e)));

        const remove = (name: string): Effect.Effect<void> =>
          fs.remove(stackDir(name), { recursive: true }).pipe(Effect.ignore);

        const resolve = (cwd: string): Effect.Effect<StackState, NoRunningStackError> =>
          Effect.gen(function* () {
            const allStacks = yield* scan();
            if (allStacks.length === 0) {
              return yield* new NoRunningStackError({ cwd });
            }

            const byDir = new Map<string, StackState>();
            for (const s of allStacks) {
              byDir.set(s.projectDir, s);
            }

            let current = path.resolve(cwd);
            const root = path.parse(current).root;

            while (true) {
              const match = byDir.get(current);
              if (match) return match;
              if (current === root) break;
              current = path.dirname(current);
            }

            return yield* new NoRunningStackError({ cwd });
          });

        const isAlive = (state: StackState): Effect.Effect<boolean> =>
          Effect.sync(() => {
            try {
              process.kill(state.pid, 0);
              return true;
            } catch {
              return false;
            }
          });

        return { stackDir, socketPath, write, read, scan, remove, resolve, isAlive };
      }),
    );
  }
}

export type StateManagerService = ServiceMap.Service.Shape<typeof StateManager>;
