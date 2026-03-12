import { Data, Effect, Layer, ServiceMap } from "effect";
import { FileSystem, Path } from "effect";
import type { AllocatedPorts } from "./PortAllocator.ts";
import {
  defaultManagedRuntimeRoot,
  defaultManagedStacksRoot,
  socketPathForRuntimeRoot,
} from "./paths.ts";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StackState {
  readonly pid: number;
  readonly name: string;
  readonly projectDir: string;
  readonly apiPort: number;
  readonly dbPort: number;
  readonly ports: AllocatedPorts;
  readonly socketPath: string;
  readonly startedAt: string;
  readonly url: string;
  readonly dbUrl: string;
  readonly publishableKey: string;
  readonly secretKey: string;
  readonly anonJwt: string;
  readonly serviceRoleJwt: string;
  readonly dockerContainerNames: ReadonlyArray<string>;
  readonly serviceEndpoints: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class StateNotFoundError extends Data.TaggedError("StateNotFoundError")<{
  readonly name: string;
}> {}

class PortsNotFoundError extends Data.TaggedError("PortsNotFoundError")<{
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

interface StateManagerPaths {
  readonly stacksRoot: string;
  readonly runtimeDirForStack: (name: string) => string;
}

export const managedStateManagerPaths = (cacheRoot: string): StateManagerPaths => {
  const stacksRoot = defaultManagedStacksRoot(cacheRoot);
  return {
    stacksRoot,
    runtimeDirForStack: (name) => defaultManagedRuntimeRoot(join(stacksRoot, name)),
  };
};

export const singleStackStateManagerPaths = (
  stackRoot: string,
  runtimeRoot: string,
  stackName: string,
): StateManagerPaths => {
  const stacksRoot = dirname(stackRoot);
  return {
    stacksRoot,
    runtimeDirForStack: (name) =>
      name === stackName ? runtimeRoot : defaultManagedRuntimeRoot(join(stacksRoot, name)),
  };
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class StateManager extends ServiceMap.Service<
  StateManager,
  {
    readonly stackDir: (name: string) => string;
    readonly dataDir: (name: string) => string;
    readonly runtimeDir: (name: string) => string;
    readonly socketPath: (name: string) => string;
    readonly portsFile: (name: string) => string;
    readonly stackExists: (name: string) => Effect.Effect<boolean>;
    readonly write: (state: StackState) => Effect.Effect<void>;
    readonly read: (name: string) => Effect.Effect<StackState, StateNotFoundError>;
    readonly scan: () => Effect.Effect<ReadonlyArray<StackState>>;
    readonly writePorts: (name: string, ports: AllocatedPorts) => Effect.Effect<void>;
    readonly readPorts: (name: string) => Effect.Effect<AllocatedPorts, PortsNotFoundError>;
    readonly scanPorts: () => Effect.Effect<ReadonlyMap<string, AllocatedPorts>>;
    readonly remove: (name: string) => Effect.Effect<void>;
    readonly removePorts: (name: string) => Effect.Effect<void>;
    readonly deleteStack: (name: string) => Effect.Effect<void>;
    readonly resolve: (cwd: string) => Effect.Effect<StackState, NoRunningStackError>;
    readonly isAlive: (state: StackState) => Effect.Effect<boolean>;
  }
>()("stack/StateManager") {
  static make(
    paths: StateManagerPaths,
  ): Layer.Layer<StateManager, never, FileSystem.FileSystem | Path.Path> {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { stacksRoot } = paths;

        const stackDir = (name: string) => path.join(stacksRoot, name);
        const dataDir = (name: string) => path.join(stackDir(name), "data");
        const runtimeDir = (name: string) => paths.runtimeDirForStack(name);
        const socketPath = (name: string) => socketPathForRuntimeRoot(runtimeDir(name));
        const stateFile = (name: string) => path.join(stackDir(name), "state.json");
        const portsFile = (name: string) => path.join(stackDir(name), "ports.json");
        const stackExists = (name: string): Effect.Effect<boolean> =>
          fs.exists(stackDir(name)).pipe(Effect.catchTag("PlatformError", (e) => Effect.die(e)));

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

        const writePorts = (name: string, ports: AllocatedPorts): Effect.Effect<void> =>
          Effect.gen(function* () {
            const dir = stackDir(name);
            yield* fs.makeDirectory(dir, { recursive: true });
            yield* fs.writeFileString(portsFile(name), JSON.stringify(ports, null, 2));
          }).pipe(Effect.catchTag("PlatformError", (e) => Effect.die(e)));

        const readPorts = (name: string): Effect.Effect<AllocatedPorts, PortsNotFoundError> =>
          Effect.gen(function* () {
            const filePath = portsFile(name);
            const exists = yield* fs.exists(filePath);
            if (!exists) return yield* new PortsNotFoundError({ name });
            const content = yield* fs.readFileString(filePath);
            return JSON.parse(content) as AllocatedPorts;
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

        const scanPorts = (): Effect.Effect<ReadonlyMap<string, AllocatedPorts>> =>
          Effect.gen(function* () {
            const exists = yield* fs.exists(stacksRoot);
            if (!exists) return new Map<string, AllocatedPorts>();

            const entries = yield* fs.readDirectory(stacksRoot);
            const portsByStack = new Map<string, AllocatedPorts>();

            for (const entry of entries) {
              const filePath = portsFile(entry);
              const fileExists = yield* fs.exists(filePath);
              if (!fileExists) continue;

              try {
                const content = yield* fs.readFileString(filePath);
                portsByStack.set(entry, JSON.parse(content) as AllocatedPorts);
              } catch {
                // Skip malformed ports files
              }
            }

            return portsByStack;
          }).pipe(Effect.catchTag("PlatformError", (e) => Effect.die(e)));

        const remove = (name: string): Effect.Effect<void> =>
          Effect.gen(function* () {
            yield* fs.remove(stateFile(name)).pipe(Effect.ignore);
            yield* fs.remove(runtimeDir(name), { recursive: true }).pipe(Effect.ignore);

            const dir = stackDir(name);
            const exists = yield* fs.exists(dir);
            if (!exists) {
              return;
            }

            const entries = yield* fs.readDirectory(dir);
            if (entries.length === 0) {
              yield* fs.remove(dir, { recursive: true }).pipe(Effect.ignore);
            }
          }).pipe(Effect.catchTag("PlatformError", (e) => Effect.die(e)));

        const removePorts = (name: string): Effect.Effect<void> =>
          Effect.gen(function* () {
            yield* fs.remove(portsFile(name)).pipe(Effect.ignore);

            const dir = stackDir(name);
            const exists = yield* fs.exists(dir);
            if (!exists) {
              return;
            }

            const entries = yield* fs.readDirectory(dir);
            if (entries.length === 0) {
              yield* fs.remove(dir, { recursive: true }).pipe(Effect.ignore);
            }
          }).pipe(Effect.catchTag("PlatformError", (e) => Effect.die(e)));

        const deleteStack = (name: string): Effect.Effect<void> =>
          Effect.gen(function* () {
            yield* fs.remove(stackDir(name), { recursive: true });
            yield* fs.remove(runtimeDir(name), { recursive: true }).pipe(Effect.ignore);
          }).pipe(Effect.catchTag("PlatformError", (e) => Effect.die(e)));

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

        return {
          stackDir,
          dataDir,
          runtimeDir,
          socketPath,
          portsFile,
          stackExists,
          write,
          read,
          scan,
          writePorts,
          readPorts,
          scanPorts,
          remove,
          removePorts,
          deleteStack,
          resolve,
          isAlive,
        };
      }),
    );
  }
}

export type StateManagerService = ServiceMap.Service.Shape<typeof StateManager>;
