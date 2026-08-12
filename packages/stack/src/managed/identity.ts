import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Effect } from "effect";
import {
  InvalidManagedIdentityError,
  ORDINARY_WORKSPACE_IDENTITY_VERSION,
  type OrdinaryWorkspaceIdentity,
} from "./model.ts";
import { assertManagedUuid, createManagedUuid } from "./ids.ts";
import { errorCode } from "./error-code.ts";
import { ordinaryWorkspaceIdentityPath } from "./paths.ts";

/**
 * The marker's own failures are the only ones this module reports. Filesystem
 * errors that are not part of the identity protocol — an unreadable workspace, a
 * full disk — are defects: no caller can act on them, and inventing an identity
 * failure for them would hide what actually went wrong.
 *
 * Every protocol step here is a promise, so the sorting happens after the effect
 * fails rather than inside `tryPromise`'s `catch` handler: `Effect.try` turns a
 * throwing handler into a defect, but a `tryPromise` handler that throws does so
 * inside the promise chain the runtime is awaiting, where nothing is watching for
 * it.
 */
const failsWithIdentity = <A>(
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, InvalidManagedIdentityError> =>
  Effect.catch(effect, (error) =>
    error instanceof InvalidManagedIdentityError ? Effect.fail(error) : Effect.die(error),
  );

/** A `catch` handler that classifies nothing, so it can never throw. */
const asRaised = (error: unknown): unknown => error;

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

export const canonicalizeOrdinaryWorkspacePath = (
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

export interface EnsureOrdinaryWorkspaceIdentityResult {
  readonly identity: OrdinaryWorkspaceIdentity;
  readonly created: boolean;
  readonly markerPath: string;
}

/**
 * Claiming a workspace stays one `await` chain rather than an `Effect.gen`
 * pipeline: the temporary file, the hardlink that makes the claim atomic, its
 * `EEXIST` re-read of the winning marker, and the `finally` that removes the
 * temporary path are a single indivisible protocol. Interleaving it with other
 * work — or interrupting it between the link and the cleanup — could leave a
 * workspace holding a stray temporary marker.
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
  const temporaryPath = `${markerPath}.tmp.${createManagedUuid(idFactory, "identity temporary id")}`;
  await writeFile(temporaryPath, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  try {
    await link(temporaryPath, markerPath);
    return { identity, created: true, markerPath };
  } catch (error: unknown) {
    if (errorCode(error) !== "EEXIST") {
      throw error;
    }
    const winner = await readIdentity(workspacePath);
    if (winner === undefined) {
      throw new InvalidManagedIdentityError({
        message: "Identity publication raced without a winning marker",
      });
    }
    return { identity: winner, created: false, markerPath };
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
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
