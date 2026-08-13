import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Effect, FileSystem, type PlatformError } from "effect";
import { claimFileAtomically } from "./atomic-claim.ts";
import {
  GIT_CHECKOUT_IDENTITY_VERSION,
  InvalidManagedIdentityError,
  ORDINARY_WORKSPACE_IDENTITY_VERSION,
  type GitCheckoutIdentity,
  type OrdinaryWorkspaceIdentity,
} from "./model.ts";
import { assertManagedUuid, createManagedUuid } from "./ids.ts";
import { asRaised, failsOnlyWith } from "./failure.ts";
import { errorCode } from "./error-code.ts";
import { gitCheckoutIdentityPath, ordinaryWorkspaceIdentityPath } from "./paths.ts";

/**
 * The marker's own failures are the only ones this module reports. Every
 * protocol step here is a promise, so each one pairs a `catch` handler that
 * classifies nothing with a recovery that sorts the failure afterwards.
 */
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
    projectId: identityField(value, "projectId"),
    checkoutId: identityField(value, "checkoutId"),
    contextId: identityField(value, "contextId"),
  };
};

/**
 * The canonical path of a workspace directory, whatever it turns out to be.
 *
 * Every resolve starts here, ordinary folders and git checkouts alike: a path
 * that is not a directory is a caller mistake rather than a workspace to
 * classify, and canonicalizing once keeps a symlinked alias from registering as
 * a second location for the same checkout.
 */
export const canonicalizeManagedWorkspacePath = (
  workspacePath: string,
): Effect.Effect<string, InvalidManagedIdentityError> =>
  failsWithIdentity(
    Effect.tryPromise({
      try: async () => {
        const info = await stat(workspacePath);
        if (!info.isDirectory()) {
          throw new InvalidManagedIdentityError({ message: `${workspacePath} is not a directory` });
        }
        return realpath(workspacePath);
      },
      catch: asRaised,
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

const readIdentity = async (
  workspacePath: string,
): Promise<OrdinaryWorkspaceIdentity | undefined> => {
  const markerPath = ordinaryWorkspaceIdentityPath(workspacePath);
  try {
    return decodeIdentity(await readFile(markerPath, "utf8"));
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
};

export const readOrdinaryWorkspaceIdentity = (
  workspacePath: string,
): Effect.Effect<OrdinaryWorkspaceIdentity | undefined, InvalidManagedIdentityError> =>
  failsWithIdentity(Effect.tryPromise({ try: () => readIdentity(workspacePath), catch: asRaised }));

/** Read-only marker probe through Effect FileSystem; absence remains undefined. */
export const readOrdinaryWorkspaceIdentityWithFileSystem = (
  workspacePath: string,
): Effect.Effect<
  OrdinaryWorkspaceIdentity | undefined,
  InvalidManagedIdentityError,
  FileSystem.FileSystem
> =>
  failsWithIdentity(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      try {
        return decodeIdentity(
          yield* fs.readFileString(ordinaryWorkspaceIdentityPath(workspacePath)),
        );
      } catch (error) {
        if (error instanceof InvalidManagedIdentityError) return yield* Effect.fail(error);
        throw error;
      }
    }).pipe(
      Effect.catchTag("PlatformError", (error: PlatformError.PlatformError) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed(undefined)
          : Effect.fail(
              new InvalidManagedIdentityError({
                message: `Ordinary workspace identity is inaccessible (${error.message})`,
              }),
            ),
      ),
    ),
  );

export interface EnsureOrdinaryWorkspaceIdentityResult {
  readonly identity: OrdinaryWorkspaceIdentity;
  readonly created: boolean;
  readonly markerPath: string;
}

/**
 * Claiming a workspace stays one `await` chain rather than an `Effect.gen`
 * pipeline: reading the marker, publishing the claim, and re-reading the marker
 * a losing claimant must adopt are a single indivisible protocol, and an
 * interruption between those steps would leave the caller with an identity no
 * workspace agreed to.
 */
const ensureIdentity = async (
  workspacePath: string,
  idFactory: () => string,
): Promise<EnsureOrdinaryWorkspaceIdentityResult> => {
  const existing = await readIdentity(workspacePath);
  const markerPath = ordinaryWorkspaceIdentityPath(workspacePath);
  if (existing !== undefined) {
    return { identity: existing, created: false, markerPath };
  }

  const identity: OrdinaryWorkspaceIdentity = {
    version: ORDINARY_WORKSPACE_IDENTITY_VERSION,
    projectId: createManagedUuid(idFactory, "projectId"),
    checkoutId: createManagedUuid(idFactory, "checkoutId"),
    contextId: createManagedUuid(idFactory, "contextId"),
  };

  await mkdir(dirname(markerPath), { recursive: true });
  const outcome = await claimFileAtomically(markerPath, `${JSON.stringify(identity, null, 2)}\n`, {
    mode: 0o600,
    temporaryId: createManagedUuid(idFactory, "identity temporary id"),
  });
  if (outcome === "claimed") {
    return { identity, created: true, markerPath };
  }

  const winner = await readIdentity(workspacePath);
  if (winner === undefined) {
    throw new InvalidManagedIdentityError({
      message: "Identity publication raced without a winning marker",
    });
  }
  return { identity: winner, created: false, markerPath };
};

export const ensureOrdinaryWorkspaceIdentity = (
  workspacePath: string,
  idFactory: () => string = randomUUID,
): Effect.Effect<EnsureOrdinaryWorkspaceIdentityResult, InvalidManagedIdentityError> =>
  failsWithIdentity(
    Effect.tryPromise({
      try: () => ensureIdentity(workspacePath, idFactory),
      catch: asRaised,
    }),
  );

/**
 * Publish a caller-selected checkout identity into a git directory without
 * ever replacing a winner. Folder-to-Git conversion uses this primitive after
 * reserving its registry transition; an existing matching marker is already
 * the settled winner, while a different marker is a transition ownership
 * failure and must not be overwritten.
 */
export const publishGitCheckoutIdentity = (
  gitDirectory: string,
  checkoutId: string,
): Effect.Effect<void, InvalidManagedIdentityError, FileSystem.FileSystem> =>
  failsWithIdentity(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const markerPath = gitCheckoutIdentityPath(gitDirectory);
      const identity: GitCheckoutIdentity = {
        version: GIT_CHECKOUT_IDENTITY_VERSION,
        checkoutId: assertManagedUuid(checkoutId, "checkoutId"),
      };
      const existing = yield* fs.readFileString(markerPath).pipe(
        Effect.map((content) => {
          try {
            const value: unknown = JSON.parse(content);
            if (typeof value !== "object" || value === null) return undefined;
            const version = Reflect.get(value, "version");
            const valueId = Reflect.get(value, "checkoutId");
            return version === GIT_CHECKOUT_IDENTITY_VERSION && typeof valueId === "string"
              ? assertManagedUuid(valueId, "checkoutId")
              : undefined;
          } catch {
            return undefined;
          }
        }),
        Effect.catchTag("PlatformError", (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed<string | undefined>(undefined)
            : Effect.fail(
                new InvalidManagedIdentityError({
                  message: `Git checkout identity is inaccessible (${error.message})`,
                }),
              ),
        ),
      );
      if (existing !== undefined) {
        if (existing !== identity.checkoutId) {
          return yield* Effect.fail(
            new InvalidManagedIdentityError({
              message: "Git checkout identity changed before folder-to-Git migration",
            }),
          );
        }
        return;
      }
      const outcome = yield* Effect.tryPromise({
        try: () =>
          claimFileAtomically(markerPath, `${JSON.stringify(identity, null, 2)}\n`, {
            mode: 0o600,
            temporaryId: createManagedUuid(randomUUID, "git checkout identity temporary id"),
          }),
        catch: asRaised,
      });
      if (outcome === "claimed") return;
      const winner = yield* fs.readFileString(markerPath).pipe(
        Effect.map((content) => {
          try {
            const value: unknown = JSON.parse(content);
            const valueId =
              typeof value === "object" && value !== null
                ? Reflect.get(value, "checkoutId")
                : undefined;
            return typeof valueId === "string"
              ? assertManagedUuid(valueId, "checkoutId")
              : undefined;
          } catch {
            return undefined;
          }
        }),
        Effect.catchTag("PlatformError", () => Effect.succeed<string | undefined>(undefined)),
      );
      if (winner !== identity.checkoutId) {
        return yield* Effect.fail(
          new InvalidManagedIdentityError({
            message: "Git checkout identity publication raced without the requested winner",
          }),
        );
      }
    }),
  );
