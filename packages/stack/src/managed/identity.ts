import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Effect, FileSystem, type PlatformError } from "effect";
import { claimFileAtomically } from "./atomic-claim.ts";
import {
  InvalidManagedIdentityError,
  ORDINARY_WORKSPACE_IDENTITY_VERSION,
  type OrdinaryWorkspaceIdentity,
} from "./model.ts";
import { assertManagedUuid, createManagedUuid } from "./ids.ts";
import { asRaised, failsOnlyWith, failsWith } from "./failure.ts";
import { errorCode } from "./error-code.ts";
import {
  gitCheckoutLocationPath,
  gitDetachedContextIdentityPath,
  ordinaryWorkspaceIdentityPath,
} from "./paths.ts";
import type { ControlOwnership } from "./control.ts";

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
    workspaceId: identityField(value, "workspaceId"),
    checkoutId: identityField(value, "checkoutId"),
    contextId: identityField(value, "contextId"),
  };
};

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
    workspaceId: createManagedUuid(idFactory, "workspaceId"),
    checkoutId: createManagedUuid(idFactory, "checkoutId"),
    contextId: createManagedUuid(idFactory, "contextId"),
  };

  await mkdir(dirname(markerPath), { recursive: true });
  const outcome = await claimFileAtomically(markerPath, `${JSON.stringify(identity, null, 2)}\n`, {
    mode: 0o600,
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

const readDetachedContextId = async (gitDirectory: string): Promise<string | undefined> => {
  try {
    return decodeDetachedContextId(
      await readFile(gitDetachedContextIdentityPath(gitDirectory), "utf8"),
    );
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
};

export const readDetachedContextIdentity = (
  gitDirectory: string,
): Effect.Effect<string | undefined, InvalidManagedIdentityError> =>
  failsWithIdentity(
    Effect.tryPromise({ try: () => readDetachedContextId(gitDirectory), catch: asRaised }),
  );

export const ensureDetachedContextIdentity = (
  gitDirectory: string,
  idFactory: () => string = randomUUID,
): Effect.Effect<
  { readonly contextId: string; readonly created: boolean },
  InvalidManagedIdentityError
> =>
  failsWithIdentity(
    Effect.tryPromise({
      try: async () => {
        const existing = await readDetachedContextId(gitDirectory);
        if (existing !== undefined) return { contextId: existing, created: false };
        const contextId = createManagedUuid(idFactory, "contextId");
        const markerPath = gitDetachedContextIdentityPath(gitDirectory);
        const outcome = await claimFileAtomically(
          markerPath,
          `${JSON.stringify({ version: DETACHED_CONTEXT_VERSION, contextId }, null, 2)}\n`,
          { mode: 0o600 },
        );
        if (outcome === "claimed") return { contextId, created: true };
        const winner = await readDetachedContextId(gitDirectory);
        if (winner === undefined) {
          throw new InvalidManagedIdentityError({
            message: "Detached context publication raced without a winning marker",
          });
        }
        return { contextId: winner, created: false };
      },
      catch: asRaised,
    }),
  );

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
            : Effect.fail(
                new InvalidManagedIdentityError({
                  message: `Git checkout location is inaccessible (${error.message})`,
                }),
              ),
        ),
      );
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

export const ensureGitCheckoutLocation = (
  gitDirectory: string,
  workspacePath: string,
): Effect.Effect<
  { readonly workspacePath: string; readonly created: boolean },
  InvalidManagedIdentityError
> =>
  failsWithIdentity(
    Effect.tryPromise({
      try: async () => {
        const existing = await (async () => {
          try {
            return decodeLocation(await readFile(gitCheckoutLocationPath(gitDirectory), "utf8"));
          } catch (error: unknown) {
            if (errorCode(error) === "ENOENT") return undefined;
            throw error;
          }
        })();
        if (existing !== undefined) return { workspacePath: existing, created: false };
        const markerPath = gitCheckoutLocationPath(gitDirectory);
        const outcome = await claimFileAtomically(
          markerPath,
          `${JSON.stringify({ version: 1, workspacePath }, null, 2)}\n`,
          { mode: 0o600 },
        );
        if (outcome === "claimed") return { workspacePath, created: true };
        const winner = decodeLocation(await readFile(markerPath, "utf8"));
        return { workspacePath: winner, created: false };
      },
      catch: asRaised,
    }),
  );

/** Replace a moved checkout marker while holding the opaque repair authority. */
export const updateGitCheckoutLocationOwned = (
  gitDirectory: string,
  expectedPath: string,
  workspacePath: string,
  ownership: ControlOwnership,
): Effect.Effect<{ readonly workspacePath: string }, InvalidManagedIdentityError> =>
  failsWithIdentity(
    Effect.tryPromise({
      try: async () => {
        void ownership;
        const markerPath = gitCheckoutLocationPath(gitDirectory);
        const current = decodeLocation(await readFile(markerPath, "utf8"));
        if (current !== expectedPath) {
          throw new InvalidManagedIdentityError({
            message: "Git checkout location changed before repair publication",
          });
        }
        const temporaryPath = `${markerPath}.tmp.${randomUUID()}`;
        await writeFile(
          temporaryPath,
          `${JSON.stringify({ version: 1, workspacePath }, null, 2)}\n`,
          { mode: 0o600 },
        );
        try {
          await rename(temporaryPath, markerPath);
        } finally {
          await unlink(temporaryPath).catch(() => undefined);
        }
        return { workspacePath };
      },
      catch: asRaised,
    }),
  );
