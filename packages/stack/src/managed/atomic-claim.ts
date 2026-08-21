import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { Data, Effect, FileSystem, Predicate, type PlatformError } from "effect";
import { errorCode } from "./error-code.ts";

export type FileClaimOutcome = "claimed" | "already-exists";

/**
 * The managed identity protocol relies on a hard link as its publication
 * primitive. A filesystem which cannot create one cannot provide the same
 * all-or-nothing claim, so it is rejected explicitly rather than silently
 * falling back to a racy direct write.
 */
export class AtomicClaimUnsupportedError extends Data.TaggedError("AtomicClaimUnsupportedError")<{
  readonly targetPath: string;
  readonly message: string;
}> {}

export interface FileClaimOptions {
  /** Mode for the published file; defaults to the process umask. */
  readonly mode?: number;
}

const unsupportedHardLink = (
  targetPath: string,
  error: PlatformError.PlatformError,
): Effect.Effect<never, AtomicClaimUnsupportedError> =>
  Effect.fail(
    new AtomicClaimUnsupportedError({
      targetPath,
      message: `Filesystem cannot atomically publish a managed claim (${error.message})`,
    }),
  );

const isHardLinkUnsupported = (error: PlatformError.PlatformError): boolean => {
  const code = errorCode(error.reason.cause);
  return code === "EPERM" || code === "ENOTSUP" || code === "EOPNOTSUPP";
};

/**
 * Publishes `content` at `targetPath` unless a claimant got there first.
 *
 * The content is written and closed in a unique sibling temporary file, then
 * published with a hard link. `link` is atomic and refuses an existing target,
 * giving every concurrent claimant the same winner without a rename-overwrite
 * window. Filesystems without hard links fail with a typed error: a direct
 * write would weaken the claim protocol and could expose a partial marker.
 */
export const claimFileAtomically = (
  targetPath: string,
  content: string,
  options: FileClaimOptions = {},
): Effect.Effect<
  FileClaimOutcome,
  PlatformError.PlatformError | AtomicClaimUnsupportedError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const temporaryPath = join(dirname(targetPath), `${basename(targetPath)}.tmp.${randomUUID()}`);
    const cleanup: Effect.Effect<void, never> = Effect.uninterruptible(
      fs
        .remove(temporaryPath, { force: true })
        .pipe(Effect.catchTag("PlatformError", () => Effect.void)),
    );

    return yield* Effect.ensuring(
      Effect.gen(function* () {
        yield* fs.writeFileString(temporaryPath, content, { mode: options.mode, flag: "wx" });
        return yield* fs.link(temporaryPath, targetPath).pipe(
          Effect.as("claimed" as const),
          Effect.catchTag(
            "PlatformError",
            (
              error,
            ): Effect.Effect<
              FileClaimOutcome,
              AtomicClaimUnsupportedError | PlatformError.PlatformError
            > => {
              if (Predicate.isTagged(error.reason, "AlreadyExists")) {
                return Effect.succeed("already-exists" as const);
              }
              return isHardLinkUnsupported(error)
                ? unsupportedHardLink(targetPath, error)
                : Effect.fail(error);
            },
          ),
        );
      }),
      cleanup,
    );
  });
