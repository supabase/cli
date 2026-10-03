import { Effect, FileSystem, Path } from "effect";
import { isSharingViolation, namespaceError, transientRetrySchedule } from "./Capabilities.ts";
import * as Drivers from "./drivers/FileSystem.ts";

export interface PublishOptions {
  readonly target: string;
  readonly content: string;
  /** "initial" publishes exclusively with a hard link; "replace" atomically renames over it. */
  readonly mode: "initial" | "replace";
  readonly platform?: NodeJS.Platform;
}

let counter = 0;

/**
 * Writes `content` as `target`, so a reader only ever sees the prior document or the complete new
 * one. Stages the full content in `target`'s own directory and fsyncs it, publishes it with a
 * hard link or a rename depending on `mode`, then fsyncs the directory. The staging path and its
 * cleanup are reserved before anything is written to it, so a write that fails partway (for
 * example `ENOSPC`) still leaves no file behind; a process killed mid publish leaves only the
 * staging file, never a partially written target.
 */
export const publish = Effect.fn("Namespace.publish")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  options: PublishOptions,
) {
  const directory = path.dirname(options.target);
  const staging = path.join(
    directory,
    `.${path.basename(options.target)}.${process.pid}-${++counter}.tmp`,
  );
  const platform = options.platform ?? process.platform;
  const retry = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.retry({ schedule: transientRetrySchedule, while: isSharingViolation(platform) }),
    );
  yield* Effect.acquireUseRelease(
    Effect.succeed(staging),
    () =>
      Effect.gen(function* () {
        yield* fs.writeFileString(staging, options.content, { mode: 0o600 });
        yield* Drivers.fsyncFile(fs, staging);
        if (options.mode === "initial") {
          // Retried separately: once the link lands, the target exists, so retrying it together
          // with removing the staging name would see a transient removal failure as `EEXIST` on
          // the next attempt instead of as the sharing violation it actually was.
          yield* retry(fs.link(staging, options.target));
          yield* retry(fs.remove(staging)).pipe(Effect.ignore);
        } else {
          yield* retry(fs.rename(staging, options.target));
        }
        yield* Drivers.fsyncDirectory(fs, directory);
      }),
    // Both modes already remove the staging name on success; only a failed attempt leaves it.
    () => retry(fs.remove(staging, { force: true })).pipe(Effect.ignore),
  ).pipe(Effect.mapError((cause) => namespaceError("publish", cause)));
});
