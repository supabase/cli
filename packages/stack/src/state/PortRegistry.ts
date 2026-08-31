import { Crypto, Effect, FileSystem, Path } from "effect";
import {
  InvalidProjectRootError,
  StackStateFormatUnsupportedError,
  StackStateInvalidError,
} from "../public/Errors.ts";
import type {
  HostPortAssignment,
  PersistedStackState,
  PrivatePortAssignment,
} from "./StackState.ts";
import { withRegistryLock, type StackStateStore } from "./StackStateStore.ts";

type PortRegistryError =
  | InvalidProjectRootError
  | StackStateInvalidError
  | StackStateFormatUnsupportedError;

export interface PortRegistry {
  readonly stateRoot: string;
  /** Serializes one complete port transaction with other processes. */
  readonly withLock: <A, E, R>(
    action: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | StackStateInvalidError, R | FileSystem.FileSystem | Path.Path>;
  /** Enumerates authoritative per-stack state documents; this method never writes a registry. */
  readonly states: Effect.Effect<
    ReadonlyArray<{ readonly stackId: string; readonly state: PersistedStackState }>,
    PortRegistryError,
    FileSystem.FileSystem | Path.Path | Crypto.Crypto
  >;
  readonly assignments: (
    stackId: string,
  ) => Effect.Effect<
    ReadonlyArray<HostPortAssignment>,
    PortRegistryError,
    FileSystem.FileSystem | Path.Path | Crypto.Crypto
  >;
  readonly privateAssignments: (
    stackId: string,
  ) => Effect.Effect<
    ReadonlyArray<PrivatePortAssignment>,
    PortRegistryError,
    FileSystem.FileSystem | Path.Path | Crypto.Crypto
  >;
}

const idPattern = /^[0-9a-f]{64}$/;

export const makePortRegistry = (options: {
  readonly stateRoot: string;
  readonly store: StackStateStore;
}): Effect.Effect<PortRegistry> =>
  Effect.succeed({
    stateRoot: options.stateRoot,
    withLock: <A, E, R>(action: Effect.Effect<A, E, R>) =>
      withRegistryLock(options.stateRoot, action),
    states: Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = path.resolve(options.stateRoot);
      const exists = yield* fs
        .exists(root)
        .pipe(Effect.mapError((error) => new StackStateInvalidError({ message: error.message })));
      if (!exists) return [];
      const entries = yield* fs
        .readDirectory(root)
        .pipe(Effect.mapError((error) => new StackStateInvalidError({ message: error.message })));
      const ids = entries.filter((entry) => idPattern.test(entry));
      const values = yield* Effect.forEach(ids, (stackId) =>
        options.store
          .read(stackId)
          .pipe(Effect.map((state) => (state === undefined ? undefined : { stackId, state }))),
      );
      return values.filter(
        (entry): entry is { readonly stackId: string; readonly state: PersistedStackState } =>
          entry !== undefined,
      );
    }),
    assignments: (stackId) =>
      options.store.read(stackId).pipe(Effect.map((state) => state?.ports ?? [])),
    privateAssignments: (stackId) =>
      options.store.read(stackId).pipe(Effect.map((state) => state?.privatePorts ?? [])),
  });
