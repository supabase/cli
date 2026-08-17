import { randomUUID } from "node:crypto";
import { Effect, FileSystem, Path, PlatformError } from "effect";
import {
  decodeManagedStackDocument,
  encodeManagedStackDocument,
  InvalidManagedStackDocumentError,
  type ManagedStackDocument,
} from "./document.ts";
import {
  assertManagedStackRoot,
  managedStackDocumentPath,
  managedStackPaths,
  managedStacksRoot,
  resolveManagedStateRoot,
} from "./paths.ts";

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
    InvalidManagedStackDocumentError | PlatformError.PlatformError
  >;
  readonly list: () => Effect.Effect<
    ReadonlyArray<ManagedStackListing>,
    PlatformError.PlatformError
  >;
  readonly write: (
    document: ManagedStackDocument,
  ) => Effect.Effect<void, InvalidManagedStackDocumentError | PlatformError.PlatformError>;
  readonly remove: (stackId: string) => Effect.Effect<void, PlatformError.PlatformError>;
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
  error.reason._tag === "NotFound";

const makeListEntry = (
  fs: FileSystem.FileSystem,
  stateRoot: string,
  stackId: string,
): Effect.Effect<ManagedStackListing | undefined, PlatformError.PlatformError> => {
  const documentPath = managedStackDocumentPath(stateRoot, stackId);
  return decodeAtPath(fs, documentPath, stackId).pipe(
    Effect.map((document): ManagedStackListing => ({ id: stackId, status: "healthy", document })),
    Effect.catchTag("InvalidManagedStackDocumentError", (cause) =>
      Effect.succeed<ManagedStackListing>({
        id: stackId,
        status: "corrupt",
        path: documentPath,
        cause,
      }),
    ),
    Effect.catchTag("PlatformError", (error) =>
      isNotFound(error)
        ? Effect.succeed(undefined)
        : Effect.succeed<ManagedStackListing>({
            id: stackId,
            status: "corrupt",
            path: documentPath,
            cause: error,
          }),
    ),
  );
};

export const makeStackStore = (
  stateRoot: string,
): Effect.Effect<StackStore, never, FileSystem.FileSystem | Path.Path> => {
  const resolvedStateRoot = resolveManagedStateRoot({ stateRoot });
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const read = (
      stackId: string,
    ): Effect.Effect<
      ManagedStackDocument | undefined,
      InvalidManagedStackDocumentError | PlatformError.PlatformError
    > => {
      const documentPath = managedStackDocumentPath(resolvedStateRoot, stackId);
      return decodeAtPath(fs, documentPath, stackId).pipe(
        Effect.catchTag("PlatformError", (error) =>
          isNotFound(error) ? Effect.succeed(undefined) : Effect.fail(error),
        ),
      );
    };

    const list = (): Effect.Effect<
      ReadonlyArray<ManagedStackListing>,
      PlatformError.PlatformError
    > =>
      Effect.gen(function* () {
        const stacksRoot = managedStacksRoot(resolvedStateRoot);
        if (!(yield* fs.exists(stacksRoot))) {
          return [];
        }
        const names = [
          ...(yield* fs
            .readDirectory(stacksRoot)
            .pipe(
              Effect.catchTag("PlatformError", (error) =>
                isNotFound(error) ? Effect.succeed<ReadonlyArray<string>>([]) : Effect.fail(error),
              ),
            )),
        ]
          .filter((name) => {
            try {
              managedStackPaths(resolvedStateRoot, name);
              return true;
            } catch {
              return false;
            }
          })
          .sort((left, right) => left.localeCompare(right));
        const entries = yield* Effect.all(
          names.map((stackId) => makeListEntry(fs, resolvedStateRoot, stackId)),
        );
        return entries.filter((entry): entry is ManagedStackListing => entry !== undefined);
      });

    const write = (
      document: ManagedStackDocument,
    ): Effect.Effect<void, InvalidManagedStackDocumentError | PlatformError.PlatformError> => {
      const paths = managedStackPaths(resolvedStateRoot, document.id);
      return writeDocumentAtomically(
        fs,
        path,
        managedStackDocumentPath(resolvedStateRoot, document.id),
        paths.root,
        document,
      );
    };

    const remove = (stackId: string): Effect.Effect<void, PlatformError.PlatformError> => {
      const paths = managedStackPaths(resolvedStateRoot, stackId);
      const safeRoot = assertManagedStackRoot(resolvedStateRoot, stackId, paths.root);
      return Effect.gen(function* () {
        if (!(yield* fs.exists(safeRoot))) return;
        const entries = yield* fs.readDirectory(safeRoot);
        for (const entry of entries) {
          if (entry === "stack.json") continue;
          yield* fs.remove(path.join(safeRoot, entry), { recursive: true, force: true });
        }
        yield* fs.remove(managedStackDocumentPath(resolvedStateRoot, stackId), {
          recursive: true,
          force: true,
        });
        yield* fs.remove(safeRoot, { recursive: true, force: true });
      });
    };

    return { stateRoot: resolvedStateRoot, read, list, write, remove };
  });
};
