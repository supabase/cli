import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { Effect, FileSystem, Predicate, Schema, type PlatformError } from "effect";
import { claimFileAtomically } from "./atomic-claim.ts";
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

/**
 * The marker's own failures are the only ones this module reports. Foreign
 * filesystem failures are translated at the boundary while the protocol
 * itself remains an interruptible Effect program.
 */
const failsWithIdentity = failsOnlyWith(InvalidManagedIdentityError);

const ordinaryWorkspaceIdentitySchema = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(ORDINARY_WORKSPACE_IDENTITY_VERSION),
    workspaceId: Schema.String,
    checkoutId: Schema.String,
    contextId: Schema.String,
  }),
);

const decodeIdentity = (
  content: string,
): Effect.Effect<OrdinaryWorkspaceIdentity, InvalidManagedIdentityError> =>
  Schema.decodeUnknownEffect(ordinaryWorkspaceIdentitySchema)(content).pipe(
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
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const markerPath = ordinaryWorkspaceIdentityPath(workspacePath);
    const content = yield* fs.readFileString(markerPath).pipe(
      Effect.catchTag("PlatformError", (error) =>
        Predicate.isTagged(error.reason, "NotFound")
          ? Effect.succeed<string | undefined>(undefined)
          : Effect.fail(
              new InvalidManagedIdentityError({
                message: `Ordinary workspace identity is inaccessible (${error.message})`,
              }),
            ),
      ),
    );
    return content === undefined ? undefined : yield* decodeIdentity(content);
  });

/** Read-only marker probe through Effect FileSystem; absence remains undefined. */
export const readOrdinaryWorkspaceIdentityWithFileSystem = (
  workspacePath: string,
): Effect.Effect<
  OrdinaryWorkspaceIdentity | undefined,
  InvalidManagedIdentityError,
  FileSystem.FileSystem
> => readIdentity(workspacePath);

export interface EnsureOrdinaryWorkspaceIdentityResult {
  readonly identity: OrdinaryWorkspaceIdentity;
  readonly created: boolean;
  readonly markerPath: string;
}

/**
 * Claiming a workspace stays one Effect pipeline: reading the marker,
 * publishing the claim, and re-reading the marker a losing claimant must adopt
 * are a single protocol, and temporary publication is interruption-safe.
 */
const ensureIdentity = (
  workspacePath: string,
  idFactory: () => string,
): Effect.Effect<
  EnsureOrdinaryWorkspaceIdentityResult,
  InvalidManagedIdentityError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const existing = yield* readIdentity(workspacePath);
    const markerPath = ordinaryWorkspaceIdentityPath(workspacePath);
    if (existing !== undefined) return { identity: existing, created: false, markerPath };

    const identity: OrdinaryWorkspaceIdentity = {
      version: ORDINARY_WORKSPACE_IDENTITY_VERSION,
      workspaceId: yield* createManagedUuidEffect(idFactory, "workspaceId"),
      checkoutId: yield* createManagedUuidEffect(idFactory, "checkoutId"),
      contextId: yield* createManagedUuidEffect(idFactory, "contextId"),
    };

    yield* fs.makeDirectory(dirname(markerPath), { recursive: true });
    const outcome = yield* claimFileAtomically(
      markerPath,
      `${JSON.stringify(identity, null, 2)}\n`,
      { mode: 0o600 },
    ).pipe(
      Effect.catchTag("AtomicClaimUnsupportedError", (error) =>
        Effect.fail(new InvalidManagedIdentityError({ message: error.message })),
      ),
      Effect.catchTag("PlatformError", (error) =>
        Effect.fail(
          new InvalidManagedIdentityError({
            message: `Identity publication failed (${error.message})`,
          }),
        ),
      ),
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
  }).pipe(
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(
        new InvalidManagedIdentityError({
          message: `Identity filesystem access failed (${error.message})`,
        }),
      ),
    ),
  );

export const ensureOrdinaryWorkspaceIdentity = (
  workspacePath: string,
  idFactory: () => string = randomUUID,
): Effect.Effect<
  EnsureOrdinaryWorkspaceIdentityResult,
  InvalidManagedIdentityError,
  FileSystem.FileSystem
> => ensureIdentity(workspacePath, idFactory);

const DETACHED_CONTEXT_VERSION = 1;

const detachedContextIdentitySchema = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(DETACHED_CONTEXT_VERSION),
    contextId: Schema.String,
  }),
);

const decodeDetachedContextId = (
  content: string,
): Effect.Effect<string, InvalidManagedIdentityError> =>
  Schema.decodeUnknownEffect(detachedContextIdentitySchema)(content).pipe(
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
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const content = yield* fs.readFileString(gitDetachedContextIdentityPath(gitDirectory)).pipe(
      Effect.catchTag("PlatformError", (error) =>
        Predicate.isTagged(error.reason, "NotFound")
          ? Effect.succeed<string | undefined>(undefined)
          : Effect.fail(
              new InvalidManagedIdentityError({
                message: `Detached context identity is inaccessible (${error.message})`,
              }),
            ),
      ),
    );
    return content === undefined ? undefined : yield* decodeDetachedContextId(content);
  });

export const readDetachedContextIdentity = (
  gitDirectory: string,
): Effect.Effect<string | undefined, InvalidManagedIdentityError, FileSystem.FileSystem> =>
  readDetachedContextId(gitDirectory);

export const ensureDetachedContextIdentity = (
  gitDirectory: string,
  idFactory: () => string = randomUUID,
): Effect.Effect<
  { readonly contextId: string; readonly created: boolean },
  InvalidManagedIdentityError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const existing = yield* readDetachedContextId(gitDirectory);
    if (existing !== undefined) return { contextId: existing, created: false };
    const contextId = yield* createManagedUuidEffect(idFactory, "contextId");
    const markerPath = gitDetachedContextIdentityPath(gitDirectory);
    const outcome = yield* claimFileAtomically(
      markerPath,
      `${JSON.stringify({ version: DETACHED_CONTEXT_VERSION, contextId }, null, 2)}\n`,
      { mode: 0o600 },
    ).pipe(
      Effect.catchTag("AtomicClaimUnsupportedError", (error) =>
        Effect.fail(new InvalidManagedIdentityError({ message: error.message })),
      ),
      Effect.catchTag("PlatformError", (error) =>
        Effect.fail(
          new InvalidManagedIdentityError({
            message: `Detached context publication failed (${error.message})`,
          }),
        ),
      ),
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
  });

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

const checkoutLocationSchema = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    workspacePath: Schema.String,
  }),
);

const decodeLocation = (content: string): Effect.Effect<string, InvalidManagedIdentityError> =>
  Schema.decodeUnknownEffect(checkoutLocationSchema)(content).pipe(
    Effect.mapError(
      (error) =>
        new InvalidManagedIdentityError({
          message: `The git checkout location is invalid: ${String(error)}`,
        }),
    ),
    Effect.map(({ workspacePath }) => workspacePath),
  );

export const ensureGitCheckoutLocation = (
  gitDirectory: string,
  workspacePath: string,
): Effect.Effect<
  { readonly workspacePath: string; readonly created: boolean },
  InvalidManagedIdentityError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const existing = yield* readGitCheckoutLocation(gitDirectory);
    if (existing !== undefined) return { workspacePath: existing, created: false };
    const markerPath = gitCheckoutLocationPath(gitDirectory);
    const outcome = yield* claimFileAtomically(
      markerPath,
      `${JSON.stringify({ version: 1, workspacePath }, null, 2)}\n`,
      { mode: 0o600 },
    ).pipe(
      Effect.catchTag("AtomicClaimUnsupportedError", (error) =>
        Effect.fail(new InvalidManagedIdentityError({ message: error.message })),
      ),
      Effect.catchTag("PlatformError", (error) =>
        Effect.fail(
          new InvalidManagedIdentityError({
            message: `Checkout location publication failed (${error.message})`,
          }),
        ),
      ),
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
  });

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
  Effect.gen(function* () {
    void ownership;
    const fs = yield* FileSystem.FileSystem;
    const markerPath = gitCheckoutLocationPath(gitDirectory);
    const current = yield* readGitCheckoutLocation(gitDirectory);
    if (current !== expectedPath) {
      return yield* Effect.fail(
        new InvalidManagedIdentityError({
          message: "Git checkout location changed before repair publication",
        }),
      );
    }
    const temporaryPath = `${markerPath}.tmp.${randomUUID()}`;
    yield* Effect.ensuring(
      Effect.gen(function* () {
        yield* fs.writeFileString(
          temporaryPath,
          `${JSON.stringify({ version: 1, workspacePath }, null, 2)}\n`,
          { mode: 0o600, flag: "wx" },
        );
        yield* fs.rename(temporaryPath, markerPath);
      }),
      Effect.uninterruptible(
        fs.remove(temporaryPath, { force: true }).pipe(Effect.catch(() => Effect.void)),
      ),
    );
    return { workspacePath };
  }).pipe(
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(
        new InvalidManagedIdentityError({
          message: `Checkout location filesystem access failed (${error.message})`,
        }),
      ),
    ),
  );
