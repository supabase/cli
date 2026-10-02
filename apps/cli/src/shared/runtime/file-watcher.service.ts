// oxlint-disable-next-line effecttsgo/node-builtin-import -- FileSystem.watch drops root events and classifies renames asynchronously.
import { existsSync, watch } from "node:fs";
import { BunPath } from "@effect/platform-bun";
import { Cause, Context, Data, Effect, Layer, Path, Queue, Stream } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../telemetry/error-actionability.ts";

type FileWatchEventType = "create" | "update" | "delete";

export interface FileWatchEvent {
  readonly path: string;
  readonly type: FileWatchEventType;
}

interface FileWatchOptions {
  readonly ignore?: ReadonlyArray<string>;
  readonly recursive?: boolean;
}

export class FileWatcherError extends Data.TaggedError("FileWatcherError")<{
  readonly path: string;
  readonly cause: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}

interface FileWatcherShape {
  readonly watch: (
    path: string,
    options?: FileWatchOptions,
  ) => Stream.Stream<ReadonlyArray<FileWatchEvent>, FileWatcherError>;
}

export class FileWatcher extends Context.Service<FileWatcher, FileWatcherShape>()(
  "supabase/runtime/FileWatcher",
) {}

export const fileWatcherLayer = Layer.effect(
  FileWatcher,
  Effect.map(Path.Path, (path) =>
    FileWatcher.of({
      watch: (root, options) =>
        Stream.callback<ReadonlyArray<FileWatchEvent>, FileWatcherError>((queue) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              const recursive = options?.recursive ?? true;
              const watcher = watch(root, { recursive }, (eventType, filename) => {
                const pathname =
                  filename === null || filename === undefined || filename.length === 0
                    ? root
                    : path.resolve(root, filename.toString());
                // `fs.watch` only distinguishes "rename" (create/delete/rename)
                // from "change" (write); an existence check on "rename"
                // disambiguates create vs delete, "change" always means update.
                const type: FileWatchEvent["type"] =
                  eventType === "rename" ? (existsSync(pathname) ? "create" : "delete") : "update";
                Queue.offerUnsafe(queue, [{ path: pathname, type }]);
              });
              watcher.on("error", (cause) => {
                Queue.failCauseUnsafe(
                  queue,
                  Cause.fail(new FileWatcherError({ path: root, cause })),
                );
              });
              return watcher;
            }),
            (watcher) =>
              Effect.sync(() => {
                watcher.close();
              }),
          ),
        ),
    }),
  ),
).pipe(Layer.provide(BunPath.layer));
