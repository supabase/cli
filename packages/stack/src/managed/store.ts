// oxlint-disable effecttsgo/node-builtin-import -- Pure path/config helpers use the host path API at a synchronous platform boundary.
// oxlint-disable effecttsgo/lazy-effect -- Store operations remain callable to defer filesystem effects until invocation.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Effect, FileSystem, Path, PlatformError, Predicate } from "effect";
import {
  decodeManagedStackDocument,
  encodeManagedStackDocument,
  InvalidManagedStackDocumentError,
  type ManagedStackDocument,
} from "./document.ts";
import {
  assertManagedStackRootEffect,
  managedStackDocumentPathEffect,
  managedStackPathsEffect,
  managedStacksRoot,
  requireExplicitManagedStateRootEffect,
} from "./paths.ts";
import { InvalidManagedIdentityError, UnsafeManagedStackPathError } from "./model.ts";

export type ManagedStackListing =
  | {
      readonly id: string;
      readonly status: "healthy";
      readonly document: ManagedStackDocument;
    }
  | {
      readonly id: string;
      readonly status: "corrupt";
      readonly path: string;
      readonly cause: InvalidManagedStackDocumentError | PlatformError.PlatformError;
    };

export interface StackStore {
  readonly stateRoot: string;
  readonly read: (
    stackId: string,
  ) => Effect.Effect<
    ManagedStackDocument | undefined,
    InvalidManagedStackDocumentError | InvalidManagedIdentityError | PlatformError.PlatformError
  >;
  readonly list: () => Effect.Effect<
    ReadonlyArray<ManagedStackListing>,
    PlatformError.PlatformError | InvalidManagedIdentityError
  >;
  readonly write: (
    document: ManagedStackDocument,
  ) => Effect.Effect<
    void,
    InvalidManagedStackDocumentError | InvalidManagedIdentityError | PlatformError.PlatformError
  >;
  readonly remove: (
    stackId: string,
  ) => Effect.Effect<
    void,
    InvalidManagedIdentityError | UnsafeManagedStackPathError | PlatformError.PlatformError
  >;
}

const writeDocumentAtomically = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  documentPath: string,
  stackRoot: string,
  document: ManagedStackDocument,
): Effect.Effect<void, InvalidManagedStackDocumentError | PlatformError.PlatformError> =>
  Effect.gen(function* () {
    const content = yield* encodeManagedStackDocument(documentPath, document);
    yield* fs.makeDirectory(stackRoot, { recursive: true, mode: 0o700 });
    const temporaryPath = path.join(stackRoot, `stack.json.tmp.${randomUUID()}`);
    yield* Effect.ensuring(
      Effect.gen(function* () {
        yield* fs.writeFileString(temporaryPath, content, { mode: 0o600 });
        yield* fs.rename(temporaryPath, documentPath);
      }),
      fs.remove(temporaryPath, { force: true }).pipe(Effect.catch(() => Effect.void)),
    );
  });

const decodeAtPath = (
  fs: FileSystem.FileSystem,
  documentPath: string,
  stackId: string,
): Effect.Effect<
  ManagedStackDocument,
  InvalidManagedStackDocumentError | PlatformError.PlatformError
> =>
  Effect.gen(function* () {
    const content = yield* fs.readFileString(documentPath);
    const document = yield* decodeManagedStackDocument(documentPath, content);
    if (document.id !== stackId) {
      return yield* new InvalidManagedStackDocumentError({ path: documentPath });
    }
    return document;
  });

const isNotFound = (error: PlatformError.PlatformError): boolean =>
  Predicate.isTagged(error.reason, "NotFound");

const makeListEntry = (
  fs: FileSystem.FileSystem,
  stateRoot: string,
  stackId: string,
): Effect.Effect<
  ManagedStackListing | undefined,
  PlatformError.PlatformError | InvalidManagedIdentityError
> =>
  Effect.gen(function* () {
    const documentPath = yield* managedStackDocumentPathEffect(stateRoot, stackId);
    return yield* decodeAtPath(fs, documentPath, stackId).pipe(
      Effect.map((document): ManagedStackListing => ({ id: stackId, status: "healthy", document })),
      Effect.catchTags({
        InvalidManagedStackDocumentError: (cause) =>
          Effect.succeed<ManagedStackListing>({
            id: stackId,
            status: "corrupt",
            path: documentPath,
            cause,
          }),
        PlatformError: (error) =>
          isNotFound(error)
            ? Effect.map(Effect.void, () => undefined)
            : Effect.succeed<ManagedStackListing>({
                id: stackId,
                status: "corrupt",
                path: documentPath,
                cause: error,
              }),
      }),
    );
  });

export const makeStackStore = (
  stateRoot: string,
): Effect.Effect<
  StackStore,
  InvalidManagedIdentityError | UnsafeManagedStackPathError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const resolvedStateRoot = yield* requireExplicitManagedStateRootEffect(stateRoot);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const read = (
      stackId: string,
    ): Effect.Effect<
      ManagedStackDocument | undefined,
      InvalidManagedStackDocumentError | InvalidManagedIdentityError | PlatformError.PlatformError
    > => {
      return Effect.gen(function* () {
        const documentPath = yield* managedStackDocumentPathEffect(resolvedStateRoot, stackId);
        return yield* decodeAtPath(fs, documentPath, stackId).pipe(
          Effect.catchTag("PlatformError", (error) =>
            isNotFound(error) ? Effect.map(Effect.void, () => undefined) : Effect.fail(error),
          ),
        );
      });
    };

    const list = (): Effect.Effect<
      ReadonlyArray<ManagedStackListing>,
      PlatformError.PlatformError | InvalidManagedIdentityError
    > =>
      Effect.gen(function* () {
        const stacksRoot = managedStacksRoot(resolvedStateRoot);
        if (!(yield* fs.exists(stacksRoot))) {
          return [];
        }
        const names = yield* fs
          .readDirectory(stacksRoot)
          .pipe(
            Effect.catchTag("PlatformError", (error) =>
              isNotFound(error) ? Effect.succeed<ReadonlyArray<string>>([]) : Effect.fail(error),
            ),
          );
        const validNames = yield* Effect.all(
          names.map((name) =>
            managedStackPathsEffect(resolvedStateRoot, name).pipe(
              Effect.map(() => name),
              Effect.catchTag("InvalidManagedIdentityError", () => Effect.void),
            ),
          ),
        );
        const sortedNames = validNames
          .filter((name): name is string => name !== undefined)
          .sort((left, right) => left.localeCompare(right));
        const entries = yield* Effect.all(
          sortedNames.map((stackId) => makeListEntry(fs, resolvedStateRoot, stackId)),
        );
        return entries.filter((entry): entry is ManagedStackListing => entry !== undefined);
      });

    const write = (
      document: ManagedStackDocument,
    ): Effect.Effect<
      void,
      InvalidManagedStackDocumentError | InvalidManagedIdentityError | PlatformError.PlatformError
    > =>
      Effect.gen(function* () {
        const paths = yield* managedStackPathsEffect(resolvedStateRoot, document.id);
        yield* writeDocumentAtomically(
          fs,
          path,
          join(paths.root, "stack.json"),
          paths.root,
          document,
        );
      });

    const remove = (
      stackId: string,
    ): Effect.Effect<
      void,
      InvalidManagedIdentityError | UnsafeManagedStackPathError | PlatformError.PlatformError
    > =>
      Effect.gen(function* () {
        const paths = yield* managedStackPathsEffect(resolvedStateRoot, stackId);
        const safeRoot = yield* assertManagedStackRootEffect(
          resolvedStateRoot,
          stackId,
          paths.root,
        );
        if (!(yield* fs.exists(safeRoot))) return;
        const entries = yield* fs.readDirectory(safeRoot);
        for (const entry of entries) {
          if (entry === "stack.json") continue;
          yield* fs.remove(path.join(safeRoot, entry), { recursive: true, force: true });
        }
        yield* fs.remove(join(safeRoot, "stack.json"), {
          recursive: true,
          force: true,
        });
        yield* fs.remove(safeRoot, { recursive: true, force: true });
      });

    return { stateRoot: resolvedStateRoot, read, list, write, remove };
  });
