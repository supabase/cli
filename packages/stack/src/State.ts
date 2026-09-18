import {
  Data,
  Duration,
  Effect,
  FileSystem,
  Context,
  Layer,
  Path,
  PlatformError,
  Predicate,
  Schedule,
  Schema,
} from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- FileSystem has no non-recursive directory removal operation.
import { rmdir } from "node:fs/promises";

const SafeId = Schema.String.pipe(
  Schema.refine((value): value is string => /^[a-zA-Z0-9_-]+$/u.test(value), {
    identifier: "SafeStateId",
    message: "Expected a safe state id",
  }),
);

export const SavedInstance = Schema.Struct({
  id: SafeId,
  creation: Schema.Unknown,
});
export interface SavedInstance extends Schema.Schema.Type<typeof SavedInstance> {}

export const SavedStack = Schema.Struct({
  id: SafeId,
  identity: Schema.Struct({
    projectRoot: Schema.String,
    branchContext: Schema.String,
    stackName: Schema.String,
  }),
  runtime: Schema.Literals(["native", "docker", "podman"]),
  instances: Schema.Array(SavedInstance),
  composition: Schema.Unknown,
  ports: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      host: Schema.String,
      port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
    }),
  ),
});
export interface SavedStack extends Schema.Schema.Type<typeof SavedStack> {}

export class StateError extends Data.TaggedError("StateError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface Interface {
  readonly read: (id: string) => Effect.Effect<SavedStack | undefined, StateError>;
  readonly list: Effect.Effect<ReadonlyArray<SavedStack>, StateError>;
  readonly save: (state: SavedStack) => Effect.Effect<void, StateError>;
  readonly remove: (id: string) => Effect.Effect<void, StateError>;
  /** Not reentrant; wrap metadata updates here, while Ports operations acquire this lock themselves. */
  readonly withLock: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | StateError, R>;
}

export class Service extends Context.Service<Service, Interface>()("@supabase/stack/State") {}

const stateError = (operation: string, cause: unknown): StateError =>
  new StateError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

const checkId = (id: string): Effect.Effect<void, StateError> =>
  Schema.is(SafeId)(id)
    ? Effect.void
    : Effect.fail(stateError("identity", `Invalid state id: ${id}`));

const decodeState = (text: string): Effect.Effect<SavedStack, StateError> =>
  Schema.decodeEffect(Schema.fromJsonString(SavedStack))(text).pipe(
    Effect.mapError((cause) => stateError("decode", cause)),
  );

const makeState = (options: {
  readonly root: string;
}): Effect.Effect<Interface, StateError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.normalize(options.root);
    const lock = path.join(root, ".registry.lock");
    yield* fs
      .makeDirectory(root, { recursive: true })
      .pipe(Effect.mapError((cause) => stateError("root", cause)));
    yield* fs.chmod(root, 0o700).pipe(Effect.mapError((cause) => stateError("root", cause)));

    const stackRoot = (id: string) => path.join(root, id);
    const statePath = (id: string) => path.join(stackRoot(id), "state.json");
    const removeEmptyDirectory = (directory: string) =>
      Effect.tryPromise({
        try: () => rmdir(directory),
        catch: (cause) => stateError("cleanup", cause),
      }).pipe(
        Effect.catch((cause) => {
          const code =
            typeof cause.cause === "object" && cause.cause !== null && "code" in cause.cause
              ? cause.cause.code
              : undefined;
          return code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST"
            ? Effect.void
            : Effect.fail(cause);
        }),
      );
    const read = Effect.fn("State.read")(function* (id: string) {
      yield* checkId(id);
      const target = statePath(id);
      const exists = yield* fs
        .exists(target)
        .pipe(Effect.mapError((cause) => stateError("read", cause)));
      if (!exists) return undefined;
      const text = yield* fs
        .readFileString(target)
        .pipe(Effect.mapError((cause) => stateError("read", cause)));
      const state = yield* decodeState(text);
      if (state.id !== id) {
        return yield* stateError("identity", "State document identity does not match its path");
      }
      return state;
    });
    const list = Effect.fn("State.list")(function* () {
      const entries = yield* fs
        .readDirectory(root)
        .pipe(Effect.mapError((cause) => stateError("list", cause)));
      const states: Array<SavedStack> = [];
      for (const entry of entries) {
        if (!Schema.is(SafeId)(entry)) continue;
        const id = entry;
        const value = yield* read(id);
        if (value !== undefined) states.push(value);
      }
      return states;
    });
    const save = Effect.fn("State.save")(function* (state: SavedStack) {
      yield* checkId(state.id);
      const target = statePath(state.id);
      const serialized = yield* Schema.encodeEffect(Schema.fromJsonString(SavedStack))(state).pipe(
        Effect.mapError((cause) => stateError("encode", cause)),
      );
      yield* fs
        .makeDirectory(stackRoot(state.id), { recursive: true, mode: 0o700 })
        .pipe(Effect.mapError((cause) => stateError("write", cause)));
      yield* Effect.acquireUseRelease(
        fs
          .makeTempDirectory({ directory: root, prefix: ".state-write-" })
          .pipe(Effect.mapError((cause) => stateError("write", cause))),
        (directory) =>
          Effect.gen(function* () {
            const temporary = path.join(directory, "state.json");
            yield* fs
              .writeFileString(temporary, serialized, { mode: 0o600 })
              .pipe(Effect.mapError((cause) => stateError("write", cause)));
            yield* fs
              .rename(temporary, target)
              .pipe(Effect.mapError((cause) => stateError("publish", cause)));
          }),
        (directory) =>
          fs
            .remove(directory, { recursive: true, force: true })
            .pipe(Effect.mapError((cause) => stateError("cleanup", cause))),
      );
    });
    const remove = Effect.fn("State.remove")(function* (id: string) {
      yield* checkId(id);
      yield* fs
        .remove(statePath(id), { force: true })
        .pipe(Effect.mapError((cause) => stateError("remove", cause)));
      yield* removeEmptyDirectory(path.join(stackRoot(id), "data"));
      yield* removeEmptyDirectory(stackRoot(id));
    });
    const withLock = Effect.fn("State.withLock")(<A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.acquireUseRelease(
          // Protect mkdir through release registration; only contention delays are interruptible.
          fs.makeDirectory(lock).pipe(
            Effect.retry({
              schedule: Schedule.spaced("50 millis").pipe(
                Schedule.upTo({ duration: "5 seconds" }),
                Schedule.modifyDelay(({ duration }) =>
                  restore(Effect.sleep(duration)).pipe(Effect.as(Duration.zero)),
                ),
              ),
              while: (cause: PlatformError.PlatformError) =>
                Predicate.isTagged(cause.reason, "AlreadyExists"),
            }),
            Effect.mapError((cause) => stateError("lock", cause)),
          ),
          () => restore(effect),
          () =>
            fs
              .remove(lock, { recursive: true, force: true })
              .pipe(Effect.mapError((cause) => stateError("unlock", cause))),
        ),
      ),
    );
    return { read, list: list(), save, remove, withLock };
  });

export const layer = (options: { readonly root: string }) =>
  Layer.effect(Service, makeState(options).pipe(Effect.map(Service.of)));
