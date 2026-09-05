import { randomUUID } from "node:crypto";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Marker parent paths are derived synchronously before native filesystem publication.
import { dirname } from "node:path";
import { Effect, FileSystem, PlatformError, Predicate, Schema } from "effect";
import { claimFileAtomically, type FileClaimOutcome } from "./atomic-claim.ts";
import {
  InvalidManagedIdentityError,
  ORDINARY_WORKSPACE_IDENTITY_VERSION,
  type OrdinaryWorkspaceIdentity,
} from "./model.ts";
import { createManagedUuidEffect, validateManagedUuid } from "./ids.ts";
import { failsOnlyWith } from "./failure.ts";
import {
  gitCheckoutLocationPath,
  gitDetachedContextIdentityPath,
  ordinaryWorkspaceIdentityPath,
} from "./paths.ts";
import type { ControlOwnership } from "./control.ts";

const failsWithIdentity = failsOnlyWith(InvalidManagedIdentityError);

const ordinaryWorkspaceIdentitySchema = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(ORDINARY_WORKSPACE_IDENTITY_VERSION),
    workspaceId: Schema.String,
    checkoutId: Schema.String,
    contextId: Schema.String,
  }),
);

const encodeOrdinaryWorkspaceIdentity = (
  identity: OrdinaryWorkspaceIdentity,
): Effect.Effect<string, InvalidManagedIdentityError> =>
  Schema.encodeEffect(ordinaryWorkspaceIdentitySchema)(identity).pipe(
    Effect.mapError(
      (error) =>
        new InvalidManagedIdentityError({
          message: `The ordinary workspace identity is invalid: ${String(error)}`,
        }),
    ),
  );

const decodeIdentity = (
  content: string,
): Effect.Effect<OrdinaryWorkspaceIdentity, InvalidManagedIdentityError> =>
  Schema.decodeEffect(ordinaryWorkspaceIdentitySchema)(content).pipe(
    Effect.mapError(
      (error) =>
        new InvalidManagedIdentityError({
          message: `The ordinary workspace identity is invalid: ${String(error)}`,
        }),
    ),
    Effect.flatMap(({ version, workspaceId, checkoutId, contextId }) =>
      Effect.all({
        workspaceId: validateManagedUuid(workspaceId, "workspaceId"),
        checkoutId: validateManagedUuid(checkoutId, "checkoutId"),
        contextId: validateManagedUuid(contextId, "contextId"),
      }).pipe(Effect.map((identity) => ({ version, ...identity }))),
    ),
  );

const inaccessibleIdentity = (
  label: string,
  error: PlatformError.PlatformError,
): InvalidManagedIdentityError =>
  new InvalidManagedIdentityError({ message: `${label} is inaccessible (${error.message})` });

const claimIdentityFile = (
  path: string,
  content: string,
  label: string,
  mode?: number,
): Effect.Effect<FileClaimOutcome, InvalidManagedIdentityError, FileSystem.FileSystem> =>
  claimFileAtomically(path, content, { mode }).pipe(
    Effect.catchTags({
      AtomicClaimUnsupportedError: (error) =>
        Effect.fail(
          new InvalidManagedIdentityError({
            message: `${label} could not be published at ${path}: ${error.message}. The filesystem must support hard links for managed identity publication.`,
          }),
        ),
      PlatformError: (error) =>
        Effect.fail(
          new InvalidManagedIdentityError({
            message: `${label} could not be published at ${path}: ${error.message}`,
          }),
        ),
    }),
  );

/** Effect FileSystem variant used by managed discovery. */
export const canonicalizeManagedWorkspacePathWithFileSystem = (
  workspacePath: string,
): Effect.Effect<string, InvalidManagedIdentityError, FileSystem.FileSystem> =>
  failsWithIdentity(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const info = yield* fs.stat(workspacePath);
      if (info.type !== "Directory") {
        return yield* new InvalidManagedIdentityError({
          message: `${workspacePath} is not a directory`,
        });
      }
      return yield* fs.realPath(workspacePath);
    }).pipe(
      Effect.catchTag("PlatformError", (error: PlatformError.PlatformError) =>
        Effect.fail(
          new InvalidManagedIdentityError({
            message: `Cannot canonicalize ${workspacePath}: ${error.message}`,
          }),
        ),
      ),
    ),
  );

const readIdentity = (
  workspacePath: string,
): Effect.Effect<
  OrdinaryWorkspaceIdentity | undefined,
  InvalidManagedIdentityError,
  FileSystem.FileSystem
> =>
  failsWithIdentity(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.readFileString(ordinaryWorkspaceIdentityPath(workspacePath)).pipe(
        Effect.flatMap((content) => decodeIdentity(content)),
        Effect.catchTag("PlatformError", (error) =>
          Predicate.isTagged(error.reason, "NotFound")
            ? Effect.void.pipe(Effect.as(undefined))
            : Effect.fail(inaccessibleIdentity("Ordinary workspace identity", error)),
        ),
      );
    }),
  );

/** Read-only marker probe through Effect FileSystem; absence remains undefined. */
export const readOrdinaryWorkspaceIdentityWithFileSystem = readIdentity;

export interface EnsureOrdinaryWorkspaceIdentityResult {
  readonly identity: OrdinaryWorkspaceIdentity;
  readonly created: boolean;
  readonly markerPath: string;
}

export const ensureOrdinaryWorkspaceIdentity = (
  workspacePath: string,
  idFactory: () => string = randomUUID,
): Effect.Effect<
  EnsureOrdinaryWorkspaceIdentityResult,
  InvalidManagedIdentityError,
  FileSystem.FileSystem
> =>
  failsWithIdentity(
    Effect.gen(function* () {
      const markerPath = ordinaryWorkspaceIdentityPath(workspacePath);
      const existing = yield* readIdentity(workspacePath);
      if (existing !== undefined) return { identity: existing, created: false, markerPath };

      const identity: OrdinaryWorkspaceIdentity = {
        version: ORDINARY_WORKSPACE_IDENTITY_VERSION,
        workspaceId: yield* createManagedUuidEffect(idFactory, "workspaceId"),
        checkoutId: yield* createManagedUuidEffect(idFactory, "checkoutId"),
        contextId: yield* createManagedUuidEffect(idFactory, "contextId"),
      };
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(dirname(markerPath), { recursive: true });
      const content = yield* encodeOrdinaryWorkspaceIdentity(identity);
      const outcome = yield* claimIdentityFile(
        markerPath,
        `${content}\n`,
        "Ordinary workspace identity",
        0o600,
      );
      if (outcome === "claimed") return { identity, created: true, markerPath };

      const winner = yield* readIdentity(workspacePath);
      if (winner === undefined) {
        return yield* new InvalidManagedIdentityError({
          message: "Identity publication raced without a winning marker",
        });
      }
      return { identity: winner, created: false, markerPath };
    }),
  );

const DETACHED_CONTEXT_VERSION = 1;

const detachedContextIdentitySchema = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(DETACHED_CONTEXT_VERSION),
    contextId: Schema.String,
  }),
);

const encodeDetachedContextIdentity = (identity: {
  readonly version: typeof DETACHED_CONTEXT_VERSION;
  readonly contextId: string;
}): Effect.Effect<string, InvalidManagedIdentityError> =>
  Schema.encodeEffect(detachedContextIdentitySchema)(identity).pipe(
    Effect.mapError(
      (error) =>
        new InvalidManagedIdentityError({
          message: `The detached context identity is invalid: ${String(error)}`,
        }),
    ),
  );

const decodeDetachedContextId = (
  content: string,
): Effect.Effect<string, InvalidManagedIdentityError> =>
  Schema.decodeEffect(detachedContextIdentitySchema)(content).pipe(
    Effect.mapError(
      (error) =>
        new InvalidManagedIdentityError({
          message: `The detached context identity is invalid: ${String(error)}`,
        }),
    ),
    Effect.flatMap(({ contextId }) => validateManagedUuid(contextId, "contextId")),
  );

const readDetachedContextId = (
  gitDirectory: string,
): Effect.Effect<string | undefined, InvalidManagedIdentityError, FileSystem.FileSystem> =>
  failsWithIdentity(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.readFileString(gitDetachedContextIdentityPath(gitDirectory)).pipe(
        Effect.flatMap((content) => decodeDetachedContextId(content)),
        Effect.catchTag("PlatformError", (error) =>
          Predicate.isTagged(error.reason, "NotFound")
            ? Effect.void.pipe(Effect.as(undefined))
            : Effect.fail(inaccessibleIdentity("Detached context identity", error)),
        ),
      );
    }),
  );

export const readDetachedContextIdentity = readDetachedContextId;

export const ensureDetachedContextIdentity = (
  gitDirectory: string,
  idFactory: () => string = randomUUID,
): Effect.Effect<
  { readonly contextId: string; readonly created: boolean },
  InvalidManagedIdentityError,
  FileSystem.FileSystem
> =>
  failsWithIdentity(
    Effect.gen(function* () {
      const existing = yield* readDetachedContextId(gitDirectory);
      if (existing !== undefined) return { contextId: existing, created: false };
      const contextId = yield* createManagedUuidEffect(idFactory, "contextId");
      const markerPath = gitDetachedContextIdentityPath(gitDirectory);
      const content = yield* encodeDetachedContextIdentity({
        version: DETACHED_CONTEXT_VERSION,
        contextId,
      });
      const outcome = yield* claimIdentityFile(
        markerPath,
        `${content}\n`,
        "Detached context identity",
        0o600,
      );
      if (outcome === "claimed") return { contextId, created: true };
      const winner = yield* readDetachedContextId(gitDirectory);
      if (winner === undefined) {
        return yield* new InvalidManagedIdentityError({
          message: "Detached context publication raced without a winning marker",
        });
      }
      return { contextId: winner, created: false };
    }),
  );

const checkoutLocationSchema = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    workspacePath: Schema.String,
  }),
);

const encodeCheckoutLocation = (location: {
  readonly version: 1;
  readonly workspacePath: string;
}): Effect.Effect<string, InvalidManagedIdentityError> =>
  Schema.encodeEffect(checkoutLocationSchema)(location).pipe(
    Effect.mapError(
      (error) =>
        new InvalidManagedIdentityError({
          message: `The git checkout location is invalid: ${String(error)}`,
        }),
    ),
  );

const decodeLocation = (content: string): Effect.Effect<string, InvalidManagedIdentityError> =>
  Schema.decodeEffect(checkoutLocationSchema)(content).pipe(
    Effect.mapError(
      (error) =>
        new InvalidManagedIdentityError({
          message: `The git checkout location is invalid: ${String(error)}`,
        }),
    ),
    Effect.map(({ workspacePath }) => workspacePath),
  );

export const readGitCheckoutLocation = (
  gitDirectory: string,
): Effect.Effect<string | undefined, InvalidManagedIdentityError, FileSystem.FileSystem> =>
  failsWithIdentity(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.readFileString(gitCheckoutLocationPath(gitDirectory)).pipe(
        Effect.flatMap((content) => decodeLocation(content)),
        Effect.catchTag("PlatformError", (error) =>
          Predicate.isTagged(error.reason, "NotFound")
            ? Effect.void.pipe(Effect.as(undefined))
            : Effect.fail(inaccessibleIdentity("Git checkout location", error)),
        ),
      );
    }),
  );

const removeTemporary = (fs: FileSystem.FileSystem, path: string): Effect.Effect<void, never> =>
  fs.remove(path, { force: true }).pipe(Effect.ignore);

const writeTemporary = (
  fs: FileSystem.FileSystem,
  path: string,
  content: string,
): Effect.Effect<void, PlatformError.PlatformError> =>
  Effect.scoped(
    fs
      .open(path, { flag: "wx", mode: 0o600 })
      .pipe(Effect.flatMap((file) => file.writeAll(new TextEncoder().encode(content)))),
  );

export const ensureGitCheckoutLocation = (
  gitDirectory: string,
  workspacePath: string,
): Effect.Effect<
  { readonly workspacePath: string; readonly created: boolean },
  InvalidManagedIdentityError,
  FileSystem.FileSystem
> =>
  failsWithIdentity(
    Effect.gen(function* () {
      const existing = yield* readGitCheckoutLocation(gitDirectory);
      if (existing !== undefined) return { workspacePath: existing, created: false };
      const markerPath = gitCheckoutLocationPath(gitDirectory);
      const content = yield* encodeCheckoutLocation({ version: 1, workspacePath });
      const outcome = yield* claimIdentityFile(
        markerPath,
        `${content}\n`,
        "Git checkout location",
        0o600,
      );
      if (outcome === "claimed") return { workspacePath, created: true };
      const winner = yield* readGitCheckoutLocation(gitDirectory);
      if (winner === undefined) {
        return yield* new InvalidManagedIdentityError({
          message: "Checkout location publication raced without a winning marker",
        });
      }
      return { workspacePath: winner, created: false };
    }),
  );

/** Replace a moved checkout marker while holding the opaque repair authority. */
export const updateGitCheckoutLocationOwned = (
  gitDirectory: string,
  expectedPath: string,
  workspacePath: string,
  ownership: ControlOwnership,
): Effect.Effect<
  { readonly workspacePath: string },
  InvalidManagedIdentityError,
  FileSystem.FileSystem
> =>
  failsWithIdentity(
    Effect.gen(function* () {
      void ownership;
      const fs = yield* FileSystem.FileSystem;
      const markerPath = gitCheckoutLocationPath(gitDirectory);
      const current = yield* readGitCheckoutLocation(gitDirectory);
      if (current === undefined || current !== expectedPath) {
        return yield* new InvalidManagedIdentityError({
          message: "Git checkout location changed before repair publication",
        });
      }
      const temporaryPath = `${markerPath}.tmp.${randomUUID()}`;
      const content = yield* encodeCheckoutLocation({ version: 1, workspacePath });
      const publication = writeTemporary(fs, temporaryPath, `${content}\n`).pipe(
        Effect.andThen(fs.rename(temporaryPath, markerPath)),
      );
      yield* Effect.ensuring(
        publication,
        Effect.uninterruptible(removeTemporary(fs, temporaryPath)),
      );
      return { workspacePath };
    }),
  );
