import { Effect, FileSystem, Path, Schema, Crypto } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { InvalidProjectRootError, InvalidStackIdentityError } from "../public/Errors.ts";
import { StackIdSchema, type StackId } from "../public/StackId.ts";
import { resolveFolderIdentity } from "./FolderIdentity.ts";
import { resolveGitIdentity } from "./GitIdentity.ts";

export interface StackIdentity {
  readonly projectRoot: string;
  readonly checkoutRoot: string;
  readonly workspaceId: string;
  readonly checkoutId: string;
  readonly branchContext: string;
  readonly localProjectKey: string;
  readonly stackName: string;
}

export interface ResolveStackIdentityOptions {
  readonly projectRoot: string;
  readonly name?: string;
}

const identityFailure = (message: string, fields?: Readonly<Record<string, unknown>>) =>
  new InvalidStackIdentityError({ message, ...fields });

const encodeTuple = (identity: StackIdentity): Uint8Array => {
  const encoder = new TextEncoder();
  const fields = [
    identity.workspaceId,
    identity.checkoutId,
    identity.branchContext,
    identity.localProjectKey,
    identity.stackName,
  ];
  const encoded = fields.map((field) => encoder.encode(field));
  const byteLength = encoded.reduce((total, bytes) => total + 4 + bytes.byteLength, 0);
  const result = new Uint8Array(byteLength);
  const view = new DataView(result.buffer);
  let offset = 0;
  for (const bytes of encoded) {
    view.setUint32(offset, bytes.byteLength, false);
    offset += 4;
    result.set(bytes, offset);
    offset += bytes.byteLength;
  }
  return result;
};

/** Hashes the complete identity tuple using length-delimited UTF-8 fields. */
export const deriveStackId = (
  identity: StackIdentity,
): Effect.Effect<StackId, InvalidStackIdentityError, Crypto.Crypto> =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const digest = yield* crypto.digest("SHA-256", encodeTuple(identity));
    let hexadecimal = "";
    for (const byte of digest) {
      hexadecimal += byte.toString(16).padStart(2, "0");
    }
    return yield* Schema.decodeEffect(StackIdSchema)(hexadecimal).pipe(
      Effect.mapError(
        (error) =>
          new InvalidStackIdentityError({
            message: `SHA-256 digest did not produce a valid StackId: ${String(error)}`,
          }),
      ),
    );
  }).pipe(
    Effect.catchTag("PlatformError", (error: PlatformError) =>
      Effect.fail(
        new InvalidStackIdentityError({
          message: `Unable to derive StackId: ${error.message}`,
        }),
      ),
    ),
  );

/** Resolves a canonical Git or ordinary-folder identity without writing state. */
export const resolveStackIdentity = (
  options: ResolveStackIdentityOptions,
): Effect.Effect<
  StackIdentity,
  InvalidProjectRootError | InvalidStackIdentityError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const projectRoot = options.projectRoot;
    if (projectRoot.trim().length === 0) {
      return yield* new InvalidProjectRootError({
        projectRoot: options.projectRoot,
        message: "The project root must not be blank",
      });
    }

    const canonicalProjectRoot = yield* fs.realPath(projectRoot);
    const info = yield* fs.stat(canonicalProjectRoot);
    if (info.type !== "Directory") {
      return yield* new InvalidProjectRootError({
        projectRoot,
        message: "The project root is not a directory",
      });
    }

    const stackName = options.name ?? "default";
    if (stackName.trim().length === 0) {
      return yield* identityFailure("The stack name must not be blank", { name: options.name });
    }

    const git = yield* resolveGitIdentity(canonicalProjectRoot);
    const parts = git ?? (yield* resolveFolderIdentity(canonicalProjectRoot));
    return { projectRoot: canonicalProjectRoot, stackName, ...parts };
  }).pipe(
    Effect.catchTag("PlatformError", (error: PlatformError) =>
      Effect.fail(
        new InvalidProjectRootError({
          projectRoot: options.projectRoot,
          message: `Unable to inspect the project root: ${error.message}`,
        }),
      ),
    ),
  );
