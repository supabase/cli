import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { Effect, FileSystem, PlatformError } from "effect";
import { claimFileAtomically, type FileClaimOutcome } from "./atomic-claim.ts";
import {
  InvalidManagedIdentityError,
  ORDINARY_WORKSPACE_IDENTITY_VERSION,
  type OrdinaryWorkspaceIdentity,
} from "./model.ts";
import { assertManagedUuid, createManagedUuid } from "./ids.ts";
import { failsOnlyWith, failsWith } from "./failure.ts";
import {
  gitCheckoutLocationPath,
  gitDetachedContextIdentityPath,
  ordinaryWorkspaceIdentityPath,
} from "./paths.ts";
import type { ControlOwnership } from "./control.ts";

const failsWithIdentity = failsOnlyWith(InvalidManagedIdentityError);

const identityField = (value: unknown, field: string): string => {
  if (typeof value !== "object" || value === null) {
    throw new InvalidManagedIdentityError({
      message: "The ordinary workspace identity must be an object",
    });
  }
  const fieldValue = Reflect.get(value, field);
  if (typeof fieldValue !== "string") {
    throw new InvalidManagedIdentityError({ message: `${field} must be an opaque UUID` });
  }
  return assertManagedUuid(fieldValue, field);
};

const decodeIdentity = (content: string): OrdinaryWorkspaceIdentity => {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (cause: unknown) {
    throw new InvalidManagedIdentityError({
      message: `The ordinary workspace identity is not JSON: ${cause}`,
    });
  }
  if (typeof value !== "object" || value === null) {
    throw new InvalidManagedIdentityError({
      message: "The ordinary workspace identity must be an object",
    });
  }
  const version = Reflect.get(value, "version");
  if (version !== ORDINARY_WORKSPACE_IDENTITY_VERSION) {
    throw new InvalidManagedIdentityError({
      message: `Unsupported ordinary workspace identity version ${String(version)}`,
    });
  }
  return {
    version,
    workspaceId: identityField(value, "workspaceId"),
    checkoutId: identityField(value, "checkoutId"),
    contextId: identityField(value, "contextId"),
  };
};

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
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(
        new InvalidManagedIdentityError({
          message: `${label} could not be published at ${path}: ${error.message}. The filesystem must support hard links for managed identity publication.`,
        }),
      ),
    ),
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
        return yield* Effect.fail(
          new InvalidManagedIdentityError({ message: `${workspacePath} is not a directory` }),
        );
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
        Effect.flatMap((content) =>
          Effect.try({
            try: () => decodeIdentity(content),
            catch: failsWith<InvalidManagedIdentityError>(InvalidManagedIdentityError),
          }),
        ),
        Effect.catchTag("PlatformError", (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed<OrdinaryWorkspaceIdentity | undefined>(undefined)
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
        workspaceId: createManagedUuid(idFactory, "workspaceId"),
        checkoutId: createManagedUuid(idFactory, "checkoutId"),
        contextId: createManagedUuid(idFactory, "contextId"),
      };
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(dirname(markerPath), { recursive: true });
      const outcome = yield* claimIdentityFile(
        markerPath,
        `${JSON.stringify(identity, null, 2)}\n`,
        "Ordinary workspace identity",
        0o600,
      );
      if (outcome === "claimed") return { identity, created: true, markerPath };

      const winner = yield* readIdentity(workspacePath);
      if (winner === undefined) {
        return yield* Effect.fail(
          new InvalidManagedIdentityError({
            message: "Identity publication raced without a winning marker",
          }),
        );
      }
      return { identity: winner, created: false, markerPath };
    }),
  );

const DETACHED_CONTEXT_VERSION = 1;

const decodeDetachedContextId = (content: string): string => {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (cause: unknown) {
    throw new InvalidManagedIdentityError({
      message: `The detached context identity is not JSON: ${cause}`,
    });
  }
  if (typeof value !== "object" || value === null) {
    throw new InvalidManagedIdentityError({
      message: "The detached context identity must be an object",
    });
  }
  if (Reflect.get(value, "version") !== DETACHED_CONTEXT_VERSION) {
    throw new InvalidManagedIdentityError({
      message: "Unsupported detached context identity version",
    });
  }
  const contextId = Reflect.get(value, "contextId");
  if (typeof contextId !== "string") {
    throw new InvalidManagedIdentityError({ message: "contextId must be an opaque UUID" });
  }
  return assertManagedUuid(contextId, "contextId");
};

const readDetachedContextId = (
  gitDirectory: string,
): Effect.Effect<string | undefined, InvalidManagedIdentityError, FileSystem.FileSystem> =>
  failsWithIdentity(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.readFileString(gitDetachedContextIdentityPath(gitDirectory)).pipe(
        Effect.flatMap((content) =>
          Effect.try({
            try: () => decodeDetachedContextId(content),
            catch: failsWith<InvalidManagedIdentityError>(InvalidManagedIdentityError),
          }),
        ),
        Effect.catchTag("PlatformError", (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed<string | undefined>(undefined)
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
      const contextId = createManagedUuid(idFactory, "contextId");
      const markerPath = gitDetachedContextIdentityPath(gitDirectory);
      const outcome = yield* claimIdentityFile(
        markerPath,
        `${JSON.stringify({ version: DETACHED_CONTEXT_VERSION, contextId }, null, 2)}\n`,
        "Detached context identity",
        0o600,
      );
      if (outcome === "claimed") return { contextId, created: true };
      const winner = yield* readDetachedContextId(gitDirectory);
      if (winner === undefined) {
        return yield* Effect.fail(
          new InvalidManagedIdentityError({
            message: "Detached context publication raced without a winning marker",
          }),
        );
      }
      return { contextId: winner, created: false };
    }),
  );

const decodeLocation = (content: string): string => {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (cause: unknown) {
    throw new InvalidManagedIdentityError({
      message: `The git checkout location is not JSON: ${cause}`,
    });
  }
  if (
    typeof value !== "object" ||
    value === null ||
    typeof Reflect.get(value, "workspacePath") !== "string"
  ) {
    throw new InvalidManagedIdentityError({ message: "workspacePath must be a string" });
  }
  return Reflect.get(value, "workspacePath");
};

export const readGitCheckoutLocation = (
  gitDirectory: string,
): Effect.Effect<string | undefined, InvalidManagedIdentityError, FileSystem.FileSystem> =>
  failsWithIdentity(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.readFileString(gitCheckoutLocationPath(gitDirectory)).pipe(
        Effect.flatMap((content) =>
          Effect.try({
            try: () => decodeLocation(content),
            catch: failsWith<InvalidManagedIdentityError>(InvalidManagedIdentityError),
          }),
        ),
        Effect.catchTag("PlatformError", (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed<string | undefined>(undefined)
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
      const outcome = yield* claimIdentityFile(
        markerPath,
        `${JSON.stringify({ version: 1, workspacePath }, null, 2)}\n`,
        "Git checkout location",
        0o600,
      );
      if (outcome === "claimed") return { workspacePath, created: true };
      const winner = yield* readGitCheckoutLocation(gitDirectory);
      if (winner === undefined) {
        return yield* Effect.fail(
          new InvalidManagedIdentityError({
            message: "Checkout location publication raced without a winning marker",
          }),
        );
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
        return yield* Effect.fail(
          new InvalidManagedIdentityError({
            message: "Git checkout location changed before repair publication",
          }),
        );
      }
      const temporaryPath = `${markerPath}.tmp.${randomUUID()}`;
      const publication = writeTemporary(
        fs,
        temporaryPath,
        `${JSON.stringify({ version: 1, workspacePath }, null, 2)}\n`,
      ).pipe(Effect.andThen(fs.rename(temporaryPath, markerPath)));
      yield* Effect.ensuring(
        publication,
        Effect.uninterruptible(removeTemporary(fs, temporaryPath)),
      );
      return { workspacePath };
    }),
  );
