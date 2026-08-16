import { randomUUID } from "node:crypto";
import { Effect, Exit, FileSystem, Path, PlatformError } from "effect";
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
  ) => Effect.Effect<void, PlatformError.PlatformError>;
  readonly remove: (stackId: string) => Effect.Effect<void, PlatformError.PlatformError>;
}

const prettyJson = (document: ManagedStackDocument): string => encodeManagedStackDocument(document);

const writeDocumentAtomically = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  documentPath: string,
  stackRoot: string,
  document: ManagedStackDocument,
): Effect.Effect<void, PlatformError.PlatformError> =>
  Effect.gen(function* () {
    yield* fs.makeDirectory(stackRoot, { recursive: true, mode: 0o700 });
    const temporaryPath = path.join(stackRoot, `stack.json.tmp.${randomUUID()}`);
    yield* Effect.ensuring(
      Effect.gen(function* () {
        yield* fs.writeFileString(temporaryPath, prettyJson(document), { mode: 0o600 });
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

const makeListEntry = (
  fs: FileSystem.FileSystem,
  stateRoot: string,
  stackId: string,
): Effect.Effect<ManagedStackListing> => {
  const documentPath = managedStackDocumentPath(stateRoot, stackId);
  return Effect.exit(
    Effect.gen(function* () {
      if (!(yield* fs.exists(documentPath))) {
        return yield* new InvalidManagedStackDocumentError({ path: documentPath });
      }
      return yield* decodeAtPath(fs, documentPath, stackId);
    }),
  ).pipe(
    Effect.map((exit) =>
      Exit.isSuccess(exit)
        ? { id: stackId, status: "healthy", document: exit.value }
        : { id: stackId, status: "corrupt", path: documentPath },
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
      return Effect.gen(function* () {
        if (!(yield* fs.exists(documentPath))) {
          return undefined;
        }
        return yield* decodeAtPath(fs, documentPath, stackId);
      });
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
        const names = [...(yield* fs.readDirectory(stacksRoot))]
          .filter((name) => {
            try {
              managedStackPaths(resolvedStateRoot, name);
              return true;
            } catch {
              return false;
            }
          })
          .sort((left, right) => left.localeCompare(right));
        return yield* Effect.all(
          names.map((stackId) => makeListEntry(fs, resolvedStateRoot, stackId)),
        );
      });

    const write = (
      document: ManagedStackDocument,
    ): Effect.Effect<void, PlatformError.PlatformError> => {
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
          force: true,
        });
        yield* fs.remove(safeRoot, { recursive: true, force: true });
      });
    };

    return { stateRoot: resolvedStateRoot, read, list, write, remove };
  });
};
