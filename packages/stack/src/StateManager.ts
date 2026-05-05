import { Data, Effect, Layer, Schema, ServiceMap } from "effect";
import { FileSystem, Path } from "effect";
import { AllocatedPortsSchema, type AllocatedPorts } from "./PortAllocator.ts";
import {
  PartialVersionManifestSchema,
  STACK_METADATA_SCHEMA_VERSION,
  StackMetadataSchema,
  type PartialVersionManifest,
  type StackMetadata,
} from "./StackMetadata.ts";
import {
  defaultManagedProjectsRoot,
  defaultManagedProjectStacksRoot,
  defaultManagedRuntimeRoot,
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
  readonly serviceEndpoints: Readonly<Record<string, string>>;
  readonly services: PartialVersionManifest;
}

const StackStateSchema = Schema.Struct({
  pid: Schema.Number,
  name: Schema.String,
  projectDir: Schema.String,
  apiPort: Schema.Number,
  dbPort: Schema.Number,
  ports: AllocatedPortsSchema,
  socketPath: Schema.String,
  startedAt: Schema.String,
  url: Schema.String,
  dbUrl: Schema.String,
  publishableKey: Schema.String,
  secretKey: Schema.String,
  anonJwt: Schema.String,
  serviceRoleJwt: Schema.String,
  serviceEndpoints: Schema.Record(Schema.String, Schema.String),
  services: PartialVersionManifestSchema,
});

const StackStateFileSchema = Schema.fromJsonString(StackStateSchema);
const StackMetadataFileSchema = Schema.fromJsonString(StackMetadataSchema);
const decodeStackStateFile = Schema.decodeUnknownSync(StackStateFileSchema);
const decodeStackMetadataFile = Schema.decodeUnknownSync(StackMetadataFileSchema);
const encodeStackState = Schema.encodeUnknownSync(StackStateSchema);
const encodeStackMetadata = Schema.encodeUnknownSync(StackMetadataSchema);

function encodePrettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeFileAtomic(
  fs: FileSystem.FileSystem,
  filePath: string,
  content: string,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const tmpPath = `${filePath}.tmp.${Date.now()}`;
    yield* fs.writeFileString(tmpPath, content);
    yield* fs.rename(tmpPath, filePath);
  }).pipe(Effect.catchTag("PlatformError", (e) => Effect.die(e)));
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class UnsupportedStackMetadataVersionError extends Data.TaggedError(
  "UnsupportedStackMetadataVersionError",
)<{
  readonly name: string;
  readonly found: number;
  readonly supported: number;
}> {}

export class StateNotFoundError extends Data.TaggedError("StateNotFoundError")<{
  readonly name: string;
}> {}

export class StackMetadataNotFoundError extends Data.TaggedError("StackMetadataNotFoundError")<{
  readonly name: string;
}> {}

export class InvalidStackStateError extends Data.TaggedError("InvalidStackStateError")<{
  readonly name: string;
  readonly path: string;
  readonly detail: string;
  readonly suggestion: string;
}> {}

export class InvalidStackMetadataError extends Data.TaggedError("InvalidStackMetadataError")<{
  readonly name: string;
  readonly path: string;
  readonly detail: string;
  readonly suggestion: string;
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
  readonly stackDirForName: (name: string) => string;
  readonly runtimeDirForStack: (name: string) => string;
}

export const projectStateManagerPaths = (
  cacheRoot: string,
  projectDir: string,
): StateManagerPaths => {
  const stacksRoot = defaultManagedProjectStacksRoot(cacheRoot, projectDir);
  return {
    stacksRoot,
    stackDirForName: (name) => join(stacksRoot, name),
    runtimeDirForStack: (name) => defaultManagedRuntimeRoot(join(stacksRoot, name)),
  };
};

export const projectStateManagerPathsFromRoot = (projectStateRoot: string): StateManagerPaths => {
  const stacksRoot = join(projectStateRoot, "stacks");
  return {
    stacksRoot,
    stackDirForName: (name) => join(stacksRoot, name),
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
    stackDirForName: (name) => join(stacksRoot, name),
    runtimeDirForStack: (name) =>
      name === stackName ? runtimeRoot : defaultManagedRuntimeRoot(join(stacksRoot, name)),
  };
};

function scanManagedFiles<T, E>(
  cacheRoot: string,
  fileName: string,
  decode: (stackName: string, filePath: string, content: string) => Effect.Effect<T, E>,
): Effect.Effect<ReadonlyArray<T>, E, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const projectsRoot = defaultManagedProjectsRoot(cacheRoot);
    const results: T[] = [];

    const projectsRootExists = yield* fs.exists(projectsRoot);
    if (!projectsRootExists) {
      return results;
    }

    const projectKeys = [...(yield* fs.readDirectory(projectsRoot))].sort((left, right) =>
      left.localeCompare(right),
    );

    for (const projectKey of projectKeys) {
      const stacksRoot = path.join(projectsRoot, projectKey, "stacks");
      const stacksRootExists = yield* fs.exists(stacksRoot);
      if (!stacksRootExists) {
        continue;
      }

      const stackNames = [...(yield* fs.readDirectory(stacksRoot))].sort((left, right) =>
        left.localeCompare(right),
      );

      for (const stackName of stackNames) {
        const filePath = path.join(stacksRoot, stackName, fileName);
        const fileExists = yield* fs.exists(filePath);
        if (!fileExists) {
          continue;
        }

        const content = yield* fs.readFileString(filePath);
        results.push(yield* decode(stackName, filePath, content));
      }
    }

    return results;
  }).pipe(Effect.catchTag("PlatformError", (e) => Effect.die(e)));
}

function invalidStackStateError(name: string, path: string): InvalidStackStateError {
  return new InvalidStackStateError({
    name,
    path,
    detail: `The local stack state file at ${path} is invalid or unreadable.`,
    suggestion: "Remove the broken stack state file or delete the stack persistence, then retry.",
  });
}

function invalidStackMetadataError(name: string, path: string): InvalidStackMetadataError {
  return new InvalidStackMetadataError({
    name,
    path,
    detail: `The local stack metadata file at ${path} is invalid or unreadable.`,
    suggestion:
      "Remove the broken stack metadata file or delete the stack persistence, then retry.",
  });
}

function decodeStackStateContent(
  name: string,
  filePath: string,
  content: string,
): Effect.Effect<StackState, InvalidStackStateError> {
  return Effect.try({
    try: () => decodeStackStateFile(content),
    catch: () => invalidStackStateError(name, filePath),
  });
}

function decodeStackMetadataContent(
  name: string,
  filePath: string,
  content: string,
): Effect.Effect<StackMetadata, InvalidStackMetadataError> {
  return Effect.try({
    try: () => decodeStackMetadataFile(content),
    catch: () => invalidStackMetadataError(name, filePath),
  });
}

function ensureSupportedMetadataVersion(
  name: string,
  metadata: StackMetadata,
): Effect.Effect<StackMetadata, UnsupportedStackMetadataVersionError> {
  if (metadata.schemaVersion > STACK_METADATA_SCHEMA_VERSION) {
    return Effect.fail(
      new UnsupportedStackMetadataVersionError({
        name,
        found: metadata.schemaVersion,
        supported: STACK_METADATA_SCHEMA_VERSION,
      }),
    );
  }

  return Effect.succeed(metadata);
}

export const scanAllManagedStates = (
  cacheRoot: string,
): Effect.Effect<
  ReadonlyArray<StackState>,
  InvalidStackStateError,
  FileSystem.FileSystem | Path.Path
> => scanManagedFiles(cacheRoot, "state.json", decodeStackStateContent);

export const scanAllManagedMetadata = (
  cacheRoot: string,
): Effect.Effect<
  ReadonlyArray<{ readonly name: string; readonly metadata: StackMetadata }>,
  InvalidStackMetadataError | UnsupportedStackMetadataVersionError,
  FileSystem.FileSystem | Path.Path
> =>
  scanManagedFiles(cacheRoot, "stack.json", (name, filePath, content) =>
    Effect.gen(function* () {
      const metadata = yield* decodeStackMetadataContent(name, filePath, content);
      return {
        name,
        metadata: yield* ensureSupportedMetadataVersion(name, metadata),
      };
    }),
  );

// ---------------------------------------------------------------------------
// Extracted operation factories
// ---------------------------------------------------------------------------

interface StateManagerDeps {
  readonly fs: FileSystem.FileSystem;
  readonly stacksRoot: string;
  readonly stackDir: (name: string) => string;
  readonly stateFile: (name: string) => string;
  readonly metadataFile: (name: string) => string;
  readonly runtimeDir: (name: string) => string;
}

function makeStackExists(deps: StateManagerDeps) {
  return (name: string): Effect.Effect<boolean> =>
    deps.fs
      .exists(deps.stackDir(name))
      .pipe(Effect.catchTag("PlatformError", (e) => Effect.die(e)));
}

function makeWrite(deps: StateManagerDeps) {
  return (state: StackState): Effect.Effect<void> =>
    Effect.gen(function* () {
      const dir = deps.stackDir(state.name);
      yield* deps.fs.makeDirectory(dir, { recursive: true });
      yield* writeFileAtomic(
        deps.fs,
        deps.stateFile(state.name),
        encodePrettyJson(encodeStackState(state)),
      );
    }).pipe(Effect.catchTag("PlatformError", (e) => Effect.die(e)));
}

function makeRead(deps: StateManagerDeps) {
  return (name: string): Effect.Effect<StackState, StateNotFoundError | InvalidStackStateError> =>
    Effect.gen(function* () {
      const filePath = deps.stateFile(name);
      const exists = yield* deps.fs.exists(filePath);
      if (!exists) return yield* new StateNotFoundError({ name });
      const content = yield* deps.fs.readFileString(filePath);
      return yield* decodeStackStateContent(name, filePath, content);
    }).pipe(Effect.catchTag("PlatformError", (e) => Effect.die(e)));
}

function makeWriteMetadata(deps: StateManagerDeps) {
  return (name: string, metadata: StackMetadata): Effect.Effect<void> =>
    Effect.gen(function* () {
      const dir = deps.stackDir(name);
      yield* deps.fs.makeDirectory(dir, { recursive: true });
      yield* writeFileAtomic(
        deps.fs,
        deps.metadataFile(name),
        encodePrettyJson(encodeStackMetadata(metadata)),
      );
    }).pipe(Effect.catchTag("PlatformError", (e) => Effect.die(e)));
}

function makeReadMetadata(deps: StateManagerDeps) {
  return (
    name: string,
  ): Effect.Effect<
    StackMetadata,
    StackMetadataNotFoundError | InvalidStackMetadataError | UnsupportedStackMetadataVersionError
  > =>
    Effect.gen(function* () {
      const filePath = deps.metadataFile(name);
      const exists = yield* deps.fs.exists(filePath);
      if (!exists) return yield* new StackMetadataNotFoundError({ name });
      const content = yield* deps.fs.readFileString(filePath);
      const metadata = yield* decodeStackMetadataContent(name, filePath, content);
      return yield* ensureSupportedMetadataVersion(name, metadata);
    }).pipe(Effect.catchTag("PlatformError", (e) => Effect.die(e)));
}

function makeUpdateMetadata(
  readMetadata: ReturnType<typeof makeReadMetadata>,
  writeMetadata: ReturnType<typeof makeWriteMetadata>,
) {
  return (
    name: string,
    update: (metadata: StackMetadata) => StackMetadata,
  ): Effect.Effect<
    void,
    StackMetadataNotFoundError | InvalidStackMetadataError | UnsupportedStackMetadataVersionError
  > =>
    Effect.gen(function* () {
      const metadata = yield* readMetadata(name);
      yield* writeMetadata(name, update(metadata));
    });
}

function makeScan(deps: StateManagerDeps) {
  return (): Effect.Effect<ReadonlyArray<StackState>, InvalidStackStateError> =>
    Effect.gen(function* () {
      const exists = yield* deps.fs.exists(deps.stacksRoot);
      if (!exists) return [];

      const entries = [...(yield* deps.fs.readDirectory(deps.stacksRoot))].sort((left, right) =>
        left.localeCompare(right),
      );
      const states: StackState[] = [];

      for (const entry of entries) {
        const filePath = deps.stateFile(entry);
        const fileExists = yield* deps.fs.exists(filePath);
        if (!fileExists) continue;

        const content = yield* deps.fs.readFileString(filePath);
        states.push(yield* decodeStackStateContent(entry, filePath, content));
      }
      return states;
    }).pipe(Effect.catchTag("PlatformError", (e) => Effect.die(e)));
}

function makeScanMetadata(deps: StateManagerDeps) {
  return (): Effect.Effect<
    ReadonlyMap<string, StackMetadata>,
    InvalidStackMetadataError | UnsupportedStackMetadataVersionError
  > =>
    Effect.gen(function* () {
      const exists = yield* deps.fs.exists(deps.stacksRoot);
      if (!exists) return new Map<string, StackMetadata>();

      const entries = [...(yield* deps.fs.readDirectory(deps.stacksRoot))].sort((left, right) =>
        left.localeCompare(right),
      );
      const metadataByStack = new Map<string, StackMetadata>();

      for (const entry of entries) {
        const filePath = deps.metadataFile(entry);
        const fileExists = yield* deps.fs.exists(filePath);
        if (!fileExists) continue;

        const content = yield* deps.fs.readFileString(filePath);
        const metadata = yield* decodeStackMetadataContent(entry, filePath, content);
        metadataByStack.set(entry, yield* ensureSupportedMetadataVersion(entry, metadata));
      }

      return metadataByStack;
    }).pipe(Effect.catchTag("PlatformError", (e) => Effect.die(e)));
}

function makeRemove(deps: StateManagerDeps) {
  return (name: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* deps.fs.remove(deps.stateFile(name)).pipe(Effect.ignore);
      yield* deps.fs.remove(deps.runtimeDir(name), { recursive: true }).pipe(Effect.ignore);

      const dir = deps.stackDir(name);
      const exists = yield* deps.fs.exists(dir);
      if (!exists) {
        return;
      }

      const entries = yield* deps.fs.readDirectory(dir);
      if (entries.length === 0) {
        yield* deps.fs.remove(dir, { recursive: true }).pipe(Effect.ignore);
      }
    }).pipe(Effect.catchTag("PlatformError", (e) => Effect.die(e)));
}

function makeDeleteStack(deps: StateManagerDeps) {
  return (name: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* deps.fs.remove(deps.stackDir(name), { recursive: true });
      yield* deps.fs.remove(deps.runtimeDir(name), { recursive: true }).pipe(Effect.ignore);
    }).pipe(Effect.catchTag("PlatformError", (e) => Effect.die(e)));
}

function makeResolve(
  path: Path.Path,
  scan: () => Effect.Effect<ReadonlyArray<StackState>, InvalidStackStateError>,
) {
  return (cwd: string): Effect.Effect<StackState, NoRunningStackError | InvalidStackStateError> =>
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
}

function makeIsAlive() {
  return (state: StackState): Effect.Effect<boolean> =>
    Effect.sync(() => {
      try {
        process.kill(state.pid, 0);
        return true;
      } catch (e: unknown) {
        return e instanceof Error && "code" in e && e.code === "EPERM";
      }
    });
}

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
    readonly metadataFile: (name: string) => string;
    readonly stackExists: (name: string) => Effect.Effect<boolean>;
    readonly write: (state: StackState) => Effect.Effect<void>;
    readonly read: (
      name: string,
    ) => Effect.Effect<StackState, StateNotFoundError | InvalidStackStateError>;
    readonly scan: () => Effect.Effect<ReadonlyArray<StackState>, InvalidStackStateError>;
    readonly writeMetadata: (name: string, metadata: StackMetadata) => Effect.Effect<void>;
    readonly updateMetadata: (
      name: string,
      update: (metadata: StackMetadata) => StackMetadata,
    ) => Effect.Effect<
      void,
      StackMetadataNotFoundError | InvalidStackMetadataError | UnsupportedStackMetadataVersionError
    >;
    readonly readMetadata: (
      name: string,
    ) => Effect.Effect<
      StackMetadata,
      StackMetadataNotFoundError | InvalidStackMetadataError | UnsupportedStackMetadataVersionError
    >;
    readonly scanMetadata: () => Effect.Effect<
      ReadonlyMap<string, StackMetadata>,
      InvalidStackMetadataError | UnsupportedStackMetadataVersionError
    >;
    readonly remove: (name: string) => Effect.Effect<void>;
    readonly deleteStack: (name: string) => Effect.Effect<void>;
    readonly resolve: (
      cwd: string,
    ) => Effect.Effect<StackState, NoRunningStackError | InvalidStackStateError>;
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
        const { stacksRoot, stackDirForName } = paths;

        const stackDir = (name: string) => stackDirForName(name);
        const dataDir = (name: string) => path.join(stackDir(name), "data");
        const runtimeDir = (name: string) => paths.runtimeDirForStack(name);
        const socketPath = (name: string) => socketPathForRuntimeRoot(runtimeDir(name));
        const stateFile = (name: string) => path.join(stackDir(name), "state.json");
        const metadataFile = (name: string) => path.join(stackDir(name), "stack.json");

        const deps: StateManagerDeps = {
          fs,
          stacksRoot,
          stackDir,
          stateFile,
          metadataFile,
          runtimeDir,
        };
        const scan = makeScan(deps);
        const writeMetadata = makeWriteMetadata(deps);
        const readMetadata = makeReadMetadata(deps);

        return {
          stackDir,
          dataDir,
          runtimeDir,
          socketPath,
          metadataFile,
          stackExists: makeStackExists(deps),
          write: makeWrite(deps),
          read: makeRead(deps),
          scan,
          writeMetadata,
          updateMetadata: makeUpdateMetadata(readMetadata, writeMetadata),
          readMetadata,
          scanMetadata: makeScanMetadata(deps),
          remove: makeRemove(deps),
          deleteStack: makeDeleteStack(deps),
          resolve: makeResolve(path, scan),
          isAlive: makeIsAlive(),
        };
      }),
    );
  }
}

export type StateManagerService = ServiceMap.Service.Shape<typeof StateManager>;
