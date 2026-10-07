import { Effect, FileSystem, Path } from "effect";
import { retrySharingViolation } from "../internal/sharing-violation.ts";
import { namespaceError } from "./Capabilities.ts";
import * as Drivers from "./drivers/FileSystem.ts";

export interface PublishOptions {
  readonly target: string;
  readonly content: string;
  readonly platform?: NodeJS.Platform;
}

let counter = 0;

/**
 * Writes `content` as `target`, so a reader only ever sees the prior document or the complete new
 * one. Stages the full content in `target`'s own directory and fsyncs it, publishes it with an
 * atomic rename, then fsyncs the directory. The staging path and its cleanup are reserved before
 * anything is written to it, so a write that fails partway (for example `ENOSPC`) still leaves no
 * file behind; a process killed mid publish leaves only the staging file, never a partially
 * written target.
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
  const retry = retrySharingViolation(options.platform);
  yield* Effect.acquireUseRelease(
    Effect.succeed(staging),
    () =>
      Effect.gen(function* () {
        yield* fs.writeFileString(staging, options.content, { mode: 0o600 });
        yield* Drivers.fsyncFile(fs, staging);
        yield* retry(fs.rename(staging, options.target));
        yield* Drivers.fsyncDirectory(fs, directory);
      }),
    // The rename already clears the staging name on success; only a failed attempt leaves it.
    () => retry(fs.remove(staging, { force: true })).pipe(Effect.ignore),
  ).pipe(Effect.mapError((cause) => namespaceError("publish", cause)));
});
